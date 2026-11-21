import { afterEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import type { DetailTypeClients } from "./resources.client-lists";
import { CatalogError } from "./resources.errors";
import { ResourcesService } from "./resources.service";
import type { DetailTypeDraft } from "./resources.types";

let listing: string[] = [];
const dropped: string[][] = [];
const clients: DetailTypeClients = {
  using: async (_tenantId, types) =>
    listing.filter((type) => types.includes(type)),
  drop: async (_tenantId, types) => {
    dropped.push([...types]);
    return types.length;
  },
};
const service = new ResourcesService({
  resources: mongo.db.resources,
  scopes: mongo.db.scopes,
  detailTypes: mongo.db.detailTypes,
  clients,
  userinfoOf: (slug) => `https://${slug}.clavix.test/userinfo`,
  findTenant: async () => undefined,
});
const A = new ObjectId();
const B = new ObjectId();
const API = "https://api.svc-spec.example/v1";

const pay = (extra: Partial<DetailTypeDraft> = {}): DetailTypeDraft => ({
  type: "payment",
  name: { en: "Payment" },
  fields: [{ key: "amount", kind: "number", required: true }],
  ...extra,
});

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CatalogError) return error.code;
    throw error;
  }
  return null;
};

afterEach(async () => {
  listing = [];
  dropped.length = 0;
  for (const tenantId of [A, B]) {
    await mongo.db.detailTypes.raw.deleteMany({ tenantId: tenantId as never });
    await mongo.db.scopes.raw.deleteMany({ tenantId: tenantId as never });
    await mongo.db.resources.raw.deleteMany({ tenantId: tenantId as never });
  }
});

describe("resources", () => {
  test("creates, lists by URI, finds and renames a resource", async () => {
    await service.createResource(A, "acme", { uri: `${API}/b`, name: "B" });
    const first = await service.createResource(A, "acme", { uri: API });
    expect(first.name).toBe("api.svc-spec.example");
    expect((await service.listResources(A)).map((r) => r.uri)).toEqual([
      API,
      `${API}/b`,
    ]);
    const renamed = await service.updateResource(A, first._id.toHexString(), {
      name: " Billing ",
      allowClientCredentials: true,
    });
    expect(renamed).toMatchObject({
      name: "Billing",
      allowClientCredentials: true,
    });
    expect(await service.findResource(A, "not an id")).toBeUndefined();
  });

  test("a repeat of the same create returns it, another name is a CONFLICT", async () => {
    const first = await service.createResource(A, "acme", {
      uri: API,
      name: "Api",
    });
    const again = await service.createResource(A, "acme", {
      uri: API,
      name: "Api",
    });
    expect(again._id.equals(first._id)).toBe(true);
    expect(
      await refusal(
        service.createResource(A, "acme", { uri: API, name: "Other" }),
      ),
    ).toBe("CONFLICT");
  });

  test("refuses the tenant's userinfo URL and an unknown resource", async () => {
    expect(
      await refusal(
        service.createResource(A, "acme", {
          uri: "https://acme.clavix.test/userinfo",
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await refusal(
        service.updateResource(A, new ObjectId().toHexString(), { name: "x" }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("another tenant's resource is not found", async () => {
    const mine = await service.createResource(A, "acme", { uri: API });
    expect(
      await service.findResource(B, mine._id.toHexString()),
    ).toBeUndefined();
    expect(await service.deleteResource(B, mine._id.toHexString())).toBe(false);
    expect(await service.listResources(B)).toEqual([]);
  });

  test("deleting a resource removes its scopes and types and prunes the clients", async () => {
    const resource = await service.createResource(A, "acme", { uri: API });
    const id = resource._id.toHexString();
    await service.createScope(A, { name: "read", resourceId: id });
    await service.createDetailType(A, id, pay());
    expect(await service.deleteResource(A, id)).toBe(true);
    expect(dropped).toEqual([["payment"]]);
    expect(await service.listScopes(A)).toEqual([]);
    expect(await service.listDetailTypes(A)).toEqual([]);
    expect(await service.deleteResource(A, id)).toBe(false);
  });
});

describe("scopes", () => {
  test("creates a scope with texts and claims, and updates them", async () => {
    const resource = await service.createResource(A, "acme", { uri: API });
    const scope = await service.createScope(A, {
      name: "read",
      resourceId: resource._id.toHexString(),
      description: { en: " Read " },
      claims: ["email", "email"],
    });
    expect(scope).toMatchObject({
      name: "read",
      description: { fr: "", en: "Read" },
      claims: ["email"],
    });
    const updated = await service.updateScope(A, scope._id.toHexString(), {
      description: { fr: "Lire" },
    });
    expect(updated.description).toEqual({ fr: "Lire", en: "Read" });
    expect(updated.claims).toEqual(["email"]);
  });

  test("only the standard scopes may have no resource", async () => {
    expect((await service.createScope(A, { name: "openid" })).resourceId).toBe(
      null,
    );
    expect(await refusal(service.createScope(A, { name: "read" }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      await refusal(
        service.createScope(A, {
          name: "read",
          resourceId: new ObjectId().toHexString(),
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a repeat is returned, a different definition is a CONFLICT", async () => {
    const resource = await service.createResource(A, "acme", { uri: API });
    const input = {
      name: "read",
      resourceId: resource._id.toHexString(),
      description: { en: "Read" },
    };
    const first = await service.createScope(A, input);
    expect((await service.createScope(A, input))._id.equals(first._id)).toBe(
      true,
    );
    expect(
      await refusal(
        service.createScope(A, { ...input, description: { en: "Other" } }),
      ),
    ).toBe("CONFLICT");
  });

  test("lists by resource, deletes idempotently and replaces a resource's scopes", async () => {
    const resource = await service.createResource(A, "acme", { uri: API });
    const rid = resource._id;
    await service.replaceResourceScopes(A, rid, ["read", "write"]);
    await service.replaceResourceScopes(A, rid, ["write", "admin"]);
    const names = (await service.listScopes(A, { resourceId: rid })).map(
      (s) => s.name,
    );
    expect(names).toEqual(["admin", "write"]);
    expect(
      [
        ...((await service.scopeNamesByResource(A)).get(rid.toHexString()) ??
          []),
      ].sort(),
    ).toEqual(["admin", "write"]);
    const [first] = await service.listScopes(A);
    const id = String(first?._id);
    expect(await service.deleteScope(A, id)).toBe(true);
    expect(await service.deleteScope(A, id)).toBe(false);
    expect(await service.findScope(A, id)).toBeUndefined();
  });
});

describe("detail types", () => {
  test("creates one on a resource, a repeat returns it, a clash is a CONFLICT", async () => {
    const resource = await service.createResource(A, "acme", { uri: API });
    const id = resource._id.toHexString();
    const first = await service.createDetailType(A, id, pay());
    const again = await service.createDetailType(A, id, pay());
    expect(again._id.equals(first._id)).toBe(true);
    expect(
      await refusal(
        service.createDetailType(A, id, pay({ name: { en: "Other" } })),
      ),
    ).toBe("CONFLICT");
    expect(
      await refusal(
        service.createDetailType(A, new ObjectId().toHexString(), pay()),
      ),
    ).toBe("NOT_FOUND");
  });

  test("an update changes the definition, and writes nothing when nothing changes", async () => {
    const resource = await service.createResource(A, "acme", { uri: API });
    const created = await service.createDetailType(
      A,
      resource._id.toHexString(),
      pay(),
    );
    const id = created._id.toHexString();
    const same = await service.updateDetailType(A, id, {});
    expect(same.updatedAt).toEqual(created.updatedAt);
    const changed = await service.updateDetailType(A, id, {
      name: { fr: "Paiement" },
    });
    expect(changed.name).toEqual({ fr: "Paiement", en: "Payment" });
    expect(
      await refusal(
        service.updateDetailType(A, new ObjectId().toHexString(), {}),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a type a client lists cannot be deleted", async () => {
    const resource = await service.createResource(A, "acme", { uri: API });
    const created = await service.createDetailType(
      A,
      resource._id.toHexString(),
      pay(),
    );
    const id = created._id.toHexString();
    listing = ["payment"];
    expect(await refusal(service.deleteDetailType(A, id))).toBe(
      "DETAIL_TYPE_IN_USE",
    );
    listing = [];
    expect(await service.deleteDetailType(A, id)).toBe(true);
    expect(await service.deleteDetailType(A, id)).toBe(false);
  });

  test("lists by resource, and compiles the stored types by resource", async () => {
    const one = await service.createResource(A, "acme", { uri: API });
    const two = await service.createResource(A, "acme", { uri: `${API}/2` });
    await service.createDetailType(A, one._id.toHexString(), pay());
    await service.createDetailType(
      A,
      two._id.toHexString(),
      pay({ type: "refund" }),
    );
    expect(
      (await service.listDetailTypes(A, { resourceId: two._id })).map(
        (t) => t.type,
      ),
    ).toEqual(["refund"]);
    const compiled = await service.compiledDetailTypes(A);
    expect(Object.keys(compiled.get(one._id.toHexString()) ?? {})).toEqual([
      "payment",
    ]);
    expect(await service.compiledDetailTypes(B)).toEqual(new Map());
  });
});
