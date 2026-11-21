import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesService } from "@/config/resources";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG, partitionOf } from "@/modules/tenants";
import { codeOf, consoleAs } from "~/console";

const REDIRECT = "https://app.example/callback";
const admin = consoleAs("cdt-admin-a");
const viewer = consoleAs("cdt-viewer-a");

let tenantA = "";

const CLIENT =
  "id name type redirectUris grantTypes requirePushedAuthorizationRequests authorizationDetailsTypes";
const CREATE = `mutation($tenantId: ID!, $input: CreateClientInput!) {
  createClient(tenantId: $tenantId, input: $input) { client { ${CLIENT} } clientSecret }
}`;
const UPDATE = `mutation($tenantId: ID!, $id: ID!, $input: UpdateClientInput!) {
  updateClient(tenantId: $tenantId, id: $id, input: $input) { ${CLIENT} }
}`;

const storeOf = async (tenantId: string) => {
  const tenant = await mongo.db.tenants.findById(tenantId);
  if (tenant === undefined) throw new Error("no tenant");
  return createMongoOAuth(oauthDb, { partition: partitionOf(tenant._id) });
};

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.adminEvents.raw.deleteMany({});
});

describe("detail types on a client (R3)", () => {
  const exchange = ["TOKEN_EXCHANGE"];
  const withTypes = (input: Record<string, unknown>) => ({
    tenantId: tenantA,
    input: {
      type: "CONFIDENTIAL",
      redirectUris: [],
      grantTypes: exchange,
      requirePushedAuthorizationRequests: true,
      ...input,
    },
  });

  let tenantC = "";
  const adminC = consoleAs("cdt-admin-c");

  beforeAll(async () => {
    tenantA = (await tenantsService.create({ slug: "cdt-a", name: "A" })).id;
    await access.grantTenant(tenantA, "cdt-admin-a", "admin");
    await access.grantTenant(tenantA, "cdt-viewer-a", "viewer");
    await mongo.db.tenants.raw.updateMany(
      { slug: "cdt-a" },
      { $set: { quotaOverrides: { clients: 1000 } } },
    );
    tenantC = (await tenantsService.create({ slug: "cdt-c", name: "C" })).id;
    await access.grantTenant(tenantC, "cdt-admin-c", "admin");
    const tenantId = new ObjectId(tenantA);
    await registerStoredResource({
      tenant: "cdt-a",
      uri: "https://pay.cdt-a.example/api",
      scopes: ["read"],
    });
    const resource = (await resourcesService.listResources(tenantId)).find(
      (item) => item.uri === "https://pay.cdt-a.example/api",
    );
    if (resource === undefined) throw new Error("no resource");
    await resourcesService.createDetailType(
      tenantId,
      resource._id.toHexString(),
      {
        type: "payment",
        name: { en: "Payment", fr: "Paiement" },
        fields: [{ key: "amount", kind: "number" }],
      },
    );
  });

  test("a client lists a type of its tenant, an update replaces or clears it, a rename keeps it", async () => {
    const created = await admin(
      CREATE,
      withTypes({ name: "Pay tv", authorizationDetailsTypes: ["payment"] }),
    );
    expect(created.errors).toBeUndefined();
    expect(created.data?.["createClient"]).toMatchObject({
      client: { id: "pay-tv", authorizationDetailsTypes: ["payment"] },
    });
    const renamed = await admin(UPDATE, {
      tenantId: tenantA,
      id: "pay-tv",
      input: { name: "Pay television" },
    });
    expect(renamed.data?.["updateClient"]).toMatchObject({
      authorizationDetailsTypes: ["payment"],
    });
    const cleared = await admin(UPDATE, {
      tenantId: tenantA,
      id: "pay-tv",
      input: { authorizationDetailsTypes: [] },
    });
    expect(cleared.data?.["updateClient"]).toMatchObject({
      authorizationDetailsTypes: [],
    });
    const plain = await admin(CREATE, {
      tenantId: tenantA,
      input: { type: "PUBLIC", name: "No types", redirectUris: [REDIRECT] },
    });
    expect(plain.data?.["createClient"]).toMatchObject({
      client: { authorizationDetailsTypes: [] },
    });
  });

  test("an unknown type, a missing PAR requirement and an unready consent page are BAD_USER_INPUT", async () => {
    expect(
      codeOf(
        await admin(
          CREATE,
          withTypes({ name: "Phantom", authorizationDetailsTypes: ["ghost"] }),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      codeOf(
        await admin(
          CREATE,
          withTypes({
            name: "No par",
            requirePushedAuthorizationRequests: false,
            authorizationDetailsTypes: ["payment"],
          }),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    // A code client: the tenant has not opted in (CLAVIX_RAR_CONSENT_READY).
    expect(
      codeOf(
        await admin(
          CREATE,
          withTypes({
            name: "Code",
            redirectUris: [REDIRECT],
            grantTypes: undefined,
            authorizationDetailsTypes: ["payment"],
          }),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(await (await storeOf(tenantA)).findClient("phantom")).toBeNull();
    expect(await (await storeOf(tenantA)).findClient("code")).toBeNull();
  });

  test("a device-grant client cannot list a type while the consent page does not show them", async () => {
    expect(
      codeOf(
        await admin(
          CREATE,
          withTypes({
            name: "Living room",
            type: "PUBLIC",
            grantTypes: ["DEVICE_CODE"],
            authorizationDetailsTypes: ["payment"],
          }),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  test("turning PAR off on a client that lists a type is refused", async () => {
    await admin(
      CREATE,
      withTypes({ name: "Pay box", authorizationDetailsTypes: ["payment"] }),
    );
    expect(
      codeOf(
        await admin(UPDATE, {
          tenantId: tenantA,
          id: "pay-box",
          input: { requirePushedAuthorizationRequests: false },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  test("a viewer cannot change the list, and another tenant's type is unknown", async () => {
    expect(
      codeOf(
        await viewer(UPDATE, {
          tenantId: tenantA,
          id: "pay-box",
          input: { authorizationDetailsTypes: [] },
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      codeOf(
        await adminC(CREATE, {
          tenantId: tenantC,
          input: {
            type: "CONFIDENTIAL",
            name: "Borrower",
            redirectUris: [],
            grantTypes: exchange,
            requirePushedAuthorizationRequests: true,
            authorizationDetailsTypes: ["payment"],
          },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  test("a client holding a type that is no longer stored can still be renamed (the race with a delete)", async () => {
    const made = await admin(
      CREATE,
      withTypes({ name: "Stale", authorizationDetailsTypes: ["payment"] }),
    );
    expect(made.errors).toBeUndefined();
    await mongo.db.detailTypes.raw.deleteMany({ type: "payment" });
    const renamed = await admin(UPDATE, {
      tenantId: tenantA,
      id: "stale",
      input: { name: "Stale again" },
    });
    expect(renamed.errors).toBeUndefined();
    expect(renamed.data?.["updateClient"]).toMatchObject({
      authorizationDetailsTypes: ["payment"],
    });
  });
});
