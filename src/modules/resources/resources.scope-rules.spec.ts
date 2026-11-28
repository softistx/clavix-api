import { afterEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { CatalogError } from "./resources.errors";
import { ResourcesService } from "./resources.service";

/** What the roles' reader answers per call (the last answer repeats), by default the first `limit` of `holders`. */
let holders: string[] = [];
let grantingCalls: string[][] = [];
/** The clients of every tenant that list a name. */
let clientRows: { tenant: ObjectId; name: string; id: string }[] = [];
let listingCalls: string[][] = [];
let onLateLook: (() => Promise<void>) | undefined;
const dropped: string[][] = [];
const warnings: string[] = [];
const nextOf = (calls: string[][]) =>
  calls.length > 1 ? calls.shift() : calls[0];
const service = new ResourcesService({
  resources: mongo.db.resources,
  scopes: mongo.db.scopes,
  detailTypes: mongo.db.detailTypes,
  clients: { using: async () => [], drop: async () => 0 },
  userinfoOf: (slug) => `https://${slug}.clavix.test/userinfo`,
  findTenant: async () => undefined,
  scopeClients: {
    listing: async (tenantId, name, limit) => {
      if (listingCalls.length === 1) await onLateLook?.();
      return (
        nextOf(listingCalls) ??
        clientRows
          .filter((row) => row.tenant.equals(tenantId) && row.name === name)
          .map((row) => row.id)
      ).slice(0, limit);
    },
  },
  rolesGranting: async (_tenantId, _scopeId, limit) =>
    (nextOf(grantingCalls) ?? holders).slice(0, limit),
  scopesDropped: async (_tenantId, scopeIds, actor) => {
    dropped.push([actor, ...scopeIds.map((id) => id.toHexString())]);
  },
  warn: (message) => {
    warnings.push(message);
  },
});
const T = new ObjectId();
const URI = "https://api.scope-rules.example/v1";

afterEach(async () => {
  holders = [];
  grantingCalls = [];
  clientRows = [];
  listingCalls = [];
  onLateLook = undefined;
  dropped.length = 0;
  warnings.length = 0;
  await mongo.db.scopes.raw.deleteMany({ tenantId: T });
  await mongo.db.resources.raw.deleteMany({ tenantId: T });
});

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CatalogError) return error;
  }
  return undefined;
};

const seeded = async () => {
  const resource = await service.createResource(T, "acme", { uri: URI });
  const scope = await service.createScope(T, {
    name: "read",
    resourceId: resource._id.toHexString(),
  });
  return { resource, scope, id: scope._id.toHexString() };
};

describe("deleteScope and the roles that grant it", () => {
  test("is refused with PERMISSION_IN_USE and the role ids", async () => {
    const { id } = await seeded();
    holders = ["r1", "r2"];
    const error = await caught(service.deleteScope(T, id, "u1"));
    expect(error?.code).toBe("PERMISSION_IN_USE");
    expect(error?.extra).toEqual({ roles: ["r1", "r2"], truncated: false });
    expect(await service.findScope(T, id)).toBeDefined();
    holders = [];
    expect(await service.deleteScope(T, id, "u1")).toBe(true);
  });

  test("lists 25 ids at most and says it was cut", async () => {
    const { id } = await seeded();
    holders = Array.from({ length: 26 }, (_, i) => `r${i}`);
    const error = await caught(service.deleteScope(T, id, "u1"));
    expect(error?.extra?.["roles"]).toHaveLength(25);
    expect(error?.extra?.["truncated"]).toBe(true);
  });

  test("pulls a role granted between the check and the delete", async () => {
    const { id } = await seeded();
    // Free at the check, granted by the time of the second look.
    grantingCalls = [[], ["late"]];
    expect(await service.deleteScope(T, id, "u1")).toBe(true);
    expect(await service.findScope(T, id)).toBeUndefined();
    expect(dropped).toEqual([["u1", id]]);
  });

  test("pulls nothing when no role was granted meanwhile", async () => {
    const { id } = await seeded();
    expect(await service.deleteScope(T, id, "u1")).toBe(true);
    expect(dropped).toEqual([]);
  });
});

describe("updateScope name", () => {
  test("renames a resource's scope", async () => {
    const { id } = await seeded();
    const { scope, renamed } = await service.updateScope(T, id, {
      name: " write ",
    });
    expect(scope.name).toBe("write");
    expect(renamed).toBe(true);
  });

  test("an update without a new name is not a rename", async () => {
    const { id } = await seeded();
    clientRows = [{ tenant: T, name: "read", id: "c1" }];
    const same = await service.updateScope(T, id, { name: "read" });
    expect(same).toMatchObject({ renamed: false, scope: { name: "read" } });
    expect((await service.updateScope(T, id, {})).renamed).toBe(false);
  });

  test("refuses a standard scope at name", async () => {
    const openid = await service.createScope(T, { name: "openid" });
    const error = await caught(
      service.updateScope(T, openid._id.toHexString(), { name: "id" }),
    );
    expect(error).toMatchObject({ code: "BAD_USER_INPUT", field: "name" });
  });

  test("refuses a name the resource already has", async () => {
    const { resource, id } = await seeded();
    await service.createScope(T, {
      name: "write",
      resourceId: resource._id.toHexString(),
    });
    const error = await caught(service.updateScope(T, id, { name: "write" }));
    expect(error).toMatchObject({ code: "CONFLICT", field: "name" });
  });

  test("refuses an invalid name", async () => {
    const { id } = await seeded();
    const error = await caught(service.updateScope(T, id, { name: "a b" }));
    expect(error?.code).toBe("BAD_USER_INPUT");
  });

  test("is refused with SCOPE_IN_USE and the client ids", async () => {
    const { id } = await seeded();
    clientRows = [{ tenant: T, name: "read", id: "c1" }];
    const error = await caught(service.updateScope(T, id, { name: "write" }));
    expect(error?.code).toBe("SCOPE_IN_USE");
    expect(error?.extra).toEqual({ clients: ["c1"], truncated: false });
    expect((await service.findScope(T, id))?.name).toBe("read");
  });

  test("another tenant's client does not block the rename", async () => {
    const { id } = await seeded();
    clientRows = [{ tenant: new ObjectId(), name: "read", id: "other" }];
    const { scope } = await service.updateScope(T, id, { name: "write" });
    expect(scope.name).toBe("write");
  });

  test("lists 25 client ids at most and says it was cut", async () => {
    const { id } = await seeded();
    clientRows = Array.from({ length: 26 }, (_, i) => ({
      tenant: T,
      name: "read",
      id: `c${i}`,
    }));
    const error = await caught(service.updateScope(T, id, { name: "write" }));
    expect(error?.extra?.["clients"]).toHaveLength(25);
    expect(error?.extra?.["truncated"]).toBe(true);
  });

  test("a revert that conflicts still refuses, and logs it", async () => {
    const { resource, id } = await seeded();
    // Free at the check; at the late look a client lists the old name and
    // another scope has taken it meanwhile.
    listingCalls = [[], ["late"]];
    onLateLook = async () => {
      await service.createScope(T, {
        name: "read",
        resourceId: resource._id.toHexString(),
      });
    };
    const error = await caught(service.updateScope(T, id, { name: "write" }));
    expect(error?.code).toBe("SCOPE_IN_USE");
    expect((await service.findScope(T, id))?.name).toBe("write");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(id);
  });

  test("puts the old name back when a client lists it right after the write", async () => {
    const { id } = await seeded();
    // Free at the check, listed by the time of the second look.
    listingCalls = [[], ["late"]];
    const error = await caught(service.updateScope(T, id, { name: "write" }));
    expect(error?.code).toBe("SCOPE_IN_USE");
    expect(error?.extra).toEqual({ clients: ["late"], truncated: false });
    expect((await service.findScope(T, id))?.name).toBe("read");
  });
});
