import { afterEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { CatalogError } from "./resources.errors";
import { ResourcesService } from "./resources.service";

let granting: string[] = [];
let listing: string[] = [];
const service = new ResourcesService({
  resources: mongo.db.resources,
  scopes: mongo.db.scopes,
  detailTypes: mongo.db.detailTypes,
  clients: { using: async () => [], drop: async () => 0 },
  userinfoOf: (slug) => `https://${slug}.clavix.test/userinfo`,
  findTenant: async () => undefined,
  scopeClients: { listing: async () => listing },
  rolesGranting: async () => granting,
  scopesDropped: async () => {},
});
const T = new ObjectId();
const URI = "https://api.scope-rules.example/v1";

afterEach(async () => {
  granting = [];
  listing = [];
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
    granting = ["r1", "r2"];
    const error = await caught(service.deleteScope(T, id));
    expect(error?.code).toBe("PERMISSION_IN_USE");
    expect(error?.extra).toEqual({ roles: ["r1", "r2"] });
    expect(await service.findScope(T, id)).toBeDefined();
    granting = [];
    expect(await service.deleteScope(T, id)).toBe(true);
  });
});

describe("updateScope name", () => {
  test("renames a resource's scope", async () => {
    const { id } = await seeded();
    const renamed = await service.updateScope(T, id, { name: " write " });
    expect(renamed.name).toBe("write");
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
    listing = ["c1"];
    const error = await caught(service.updateScope(T, id, { name: "write" }));
    expect(error?.code).toBe("SCOPE_IN_USE");
    expect(error?.extra).toEqual({ clients: ["c1"] });
    expect((await service.findScope(T, id))?.name).toBe("read");
  });

  test("an unchanged name is not a rename", async () => {
    const { id } = await seeded();
    listing = ["c1"];
    const same = await service.updateScope(T, id, { name: "read" });
    expect(same.name).toBe("read");
  });
});
