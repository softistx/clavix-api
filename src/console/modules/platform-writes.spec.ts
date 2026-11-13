import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  type SigningKeyStore,
} from "@softistx/janus-oauth";
import { createApp } from "@/app";
import { access, linkTenantToPlatform } from "@/config/access";
import { createConsoleDeps } from "@/config/console";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { tenantResolver } from "@/config/tenancy";
import { authFor, claimsFor, forTenant } from "@/config/users";
import { CONSOLE_CLIENT_ID, CONSOLE_PATH } from "@/console/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { type ConsoleResult, codeOf } from "~/console";

// A tenant-level role on the `clavix` tenant is not the platform's: every
// console write that targets it needs the platform permission.
let ADMIN = "";
let VIEWER = "";
let OWNER = "";

// The real wiring (issuers, grants): deleting a user needs the user's grants.
const keys = new Map<string, SigningKeyStore>();
const issuers = createClavixOAuthIssuers({
  resolver: tenantResolver,
  db: oauthDb,
  signingKeysFor: (tenantId) => {
    let store = keys.get(tenantId);
    if (store === undefined) {
      store = createMemorySigningKeys();
      keys.set(tenantId, store);
    }
    return store;
  },
  authFor,
  claimsFor,
  resourcesFor,
});
// The bearer token is the user id: tokens are console.spec's business.
const app = createApp({
  oauth: issuers,
  console: {
    ...createConsoleDeps(issuers),
    authenticate: async (request) => {
      const userId = request.headers
        .get("authorization")
        ?.replace(/^Bearer /, "");
      return userId === undefined
        ? null
        : {
            userId,
            clientId: CONSOLE_CLIENT_ID,
            grantId: "spec",
            scopes: ["console"],
          };
    },
  },
});
const as =
  (who: () => string) =>
  async (query: string): Promise<ConsoleResult> => {
    const response = await app.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${who()}`,
      },
      body: JSON.stringify({ query }),
    });
    return (await response.json()) as ConsoleResult;
  };
const tenantAdmin = as(() => ADMIN);
const tenantViewer = as(() => VIEWER);
const platformOwner = as(() => OWNER);

let clavix = "";
let victim = "";

const writes = (t: string, u: string) => ({
  disableUser: `mutation { disableUser(tenantId: "${t}", userId: "${u}") { id } }`,
  deleteUser: `mutation { deleteUser(tenantId: "${t}", userId: "${u}") }`,
  revokeUserSessions: `mutation { revokeUserSessions(tenantId: "${t}", userId: "${u}") }`,
  revokeGrant: `mutation { revokeGrant(tenantId: "${t}", userId: "${u}", grantId: "g") }`,
  inviteUser: `mutation { inviteUser(tenantId: "${t}", email: "x@pw.test") { id } }`,
  addDomain: `mutation { addDomain(tenantId: "${t}", host: "pw.example.test") { id } }`,
  setPrimaryDomain: `mutation { setPrimaryDomain(tenantId: "${t}", id: "x") { id } }`,
  removeDomain: `mutation { removeDomain(tenantId: "${t}", id: "x") }`,
  updateSignInMethods: `mutation { updateSignInMethods(tenantId: "${t}", methods: []) { __typename } }`,
  removeSocialProvider: `mutation { removeSocialProvider(tenantId: "${t}", provider: GOOGLE) { __typename } }`,
  createClient: `mutation { createClient(tenantId: "${t}", input: { name: "Evil", type: PUBLIC, redirectUris: ["https://e.example/cb"] }) { clientSecret } }`,
  updateClient: `mutation { updateClient(tenantId: "${t}", id: "x", input: { name: "Z" }) { id } }`,
  rotateClientSecret: `mutation { rotateClientSecret(tenantId: "${t}", id: "x") { clientSecret } }`,
  deleteClient: `mutation { deleteClient(tenantId: "${t}", id: "x") }`,
  updateBranding: `mutation { updateBranding(tenantId: "${t}", input: { displayName: "X", seed: "#336699" }) { __typename } }`,
  updateTenant: `mutation { updateTenant(id: "${t}", input: { name: "X" }) { id } }`,
  createRole: `mutation { createRole(tenantId: "${t}", input: { name: "r" }) { id } }`,
  createResource: `mutation { createResource(tenantId: "${t}", input: { uri: "https://r.example.test/" }) { id } }`,
  inviteAdmin: `mutation { inviteAdmin(tenantId: "${t}", email: "a@pw.test", role: VIEWER) { id } }`,
  removeMembership: `mutation { removeMembership(tenantId: "${t}", userId: "${u}") }`,
});

beforeAll(async () => {
  const found = await mongo.db.tenants.findFirst({
    slug: PLATFORM_TENANT_SLUG,
  });
  clavix = found?._id.toHexString() ?? "";
  await linkTenantToPlatform(clavix);
  const resolved = await tenantResolver.resolveHost(
    `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
  );
  const auth = resolved === null ? null : await forTenant(resolved);
  if (auth === null) throw new Error("no clavix pool");
  const operator = async (email: string) =>
    (await auth.create({ email, name: email })).id;
  ADMIN = await operator("admin@pw.test");
  VIEWER = await operator("viewer@pw.test");
  OWNER = await operator("owner@pw.test");
  await access.grantTenant(clavix, ADMIN, "admin");
  await access.grantTenant(clavix, VIEWER, "viewer");
  await access.grantTenant(clavix, ADMIN, "owner");
  await access.grantPlatform(OWNER, "owner");
  victim = (await auth.create({ email: "victim@pw.test", name: "V" })).id;
});

afterAll(async () => {
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("writes on the clavix tenant", () => {
  test("a tenant-level owner of clavix is FORBIDDEN on every write", async () => {
    for (const [name, query] of Object.entries(writes(clavix, victim))) {
      expect([name, codeOf(await tenantAdmin(query))]).toEqual([
        name,
        "FORBIDDEN",
      ]);
    }
  });

  test("a viewer of clavix is FORBIDDEN on writes and still reads", async () => {
    expect(codeOf(await tenantViewer(writes(clavix, victim).disableUser))).toBe(
      "FORBIDDEN",
    );
    const read = await tenantViewer(
      `{ users(tenantId: "${clavix}") { totalCount } }`,
    );
    expect(read.errors).toBeUndefined();
  });

  test("a platform owner is past the guard on every write", async () => {
    // An unknown user: the writes get past the guard and find nothing to change.
    for (const [name, query] of Object.entries(writes(clavix, "ghost"))) {
      const code = codeOf(await platformOwner(query));
      expect([name, code === "FORBIDDEN"]).toEqual([name, false]);
    }
  });

  test("a platform owner disables and enables a clavix user", async () => {
    const t = writes(clavix, victim);
    expect((await platformOwner(t.disableUser)).errors).toBeUndefined();
    expect(
      (
        await platformOwner(
          `mutation { enableUser(tenantId: "${clavix}", userId: "${victim}") { active } }`,
        )
      ).data,
    ).toEqual({ enableUser: { active: true } });
  });

  test("another tenant's writes keep the tenant-level guard", async () => {
    // Editing is enough there: a tenant admin of clavix has no role on it.
    expect(
      codeOf(
        await tenantAdmin(
          writes("0123456789abcdef01234567", victim).disableUser,
        ),
      ),
    ).toBe("FORBIDDEN");
  });
});

describe("deleting a clavix user", () => {
  test("removes their console roles, on a repeat too", async () => {
    const resolved = await tenantResolver.resolveHost(
      `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
    );
    const auth = resolved === null ? null : await forTenant(resolved);
    if (auth === null) throw new Error("no clavix pool");
    const leaving = (await auth.create({ email: "leaving@pw.test" })).id;
    await access.grantPlatform(leaving, "viewer");
    await access.grantTenant(clavix, leaving, "admin");
    const del = writes(clavix, leaving).deleteUser;
    const first = await platformOwner(del);
    expect(first.errors).toBeUndefined();
    expect(first.data).toEqual({ deleteUser: true });
    expect(await access.platformRole(leaving)).toBeNull();
    expect(await access.memberships(leaving)).toEqual([]);
    await access.grantPlatform(leaving, "viewer");
    expect((await platformOwner(del)).data).toEqual({ deleteUser: true });
    expect(await access.platformRole(leaving)).toBeNull();
  });
});
