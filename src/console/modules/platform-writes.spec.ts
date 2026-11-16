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
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { authFor, claimsFor, forTenant } from "@/config/users";
import { CONSOLE_CLIENT_ID, CONSOLE_PATH } from "@/console/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { type ConsoleResult, codeOf, verifiedCallers } from "~/console";

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
    ...verifiedCallers(createConsoleDeps(issuers)),
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
            clientName: null,
            bound: null,
            jkt: null,
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
let other = "";
let mkOperator: (email: string) => Promise<string> = async () => "";

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
  mkOperator = async (email: string) =>
    (await auth.create({ email, name: email })).id;
  const operator = mkOperator;
  ADMIN = await operator("admin@pw.test");
  VIEWER = await operator("viewer@pw.test");
  OWNER = await operator("owner@pw.test");
  await access.grantTenant(clavix, ADMIN, "admin");
  await access.grantTenant(clavix, VIEWER, "viewer");
  await access.grantTenant(clavix, ADMIN, "owner");
  await access.grantPlatform(OWNER, "owner");
  other = (await tenantsService.create({ slug: "pw-other", name: "Other" })).id;
  await access.grantTenant(other, ADMIN, "admin");
  victim = (await auth.create({ email: "victim@pw.test", name: "V" })).id;
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
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

  test("an upper-case spelling of the clavix id is the same tenant", async () => {
    for (const [name, query] of Object.entries(
      writes(clavix.toUpperCase(), victim),
    )) {
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
    // A tenant admin of an ordinary tenant still writes there.
    expect(codeOf(await tenantAdmin(writes(other, "ghost").disableUser))).toBe(
      "NOT_FOUND",
    );
    expect(codeOf(await tenantViewer(writes(other, "ghost").disableUser))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("platform owners", () => {
  test("a platform admin cannot disable or delete one, an owner can", async () => {
    const admin = await mkOperator("padmin@pw.test");
    await access.grantPlatform(admin, "admin");
    const asAdmin = as(() => admin);
    const owner2 = await mkOperator("owner2@pw.test");
    await access.grantPlatform(owner2, "owner");
    const t = writes(clavix, owner2);
    expect(codeOf(await asAdmin(t.disableUser))).toBe("FORBIDDEN");
    expect(codeOf(await asAdmin(t.deleteUser))).toBe("FORBIDDEN");
    expect((await platformOwner(t.disableUser)).errors).toBeUndefined();
  });

  test("a platform admin cannot disable or delete a tenant owner either, but can enable", async () => {
    const admin = await mkOperator("padmin2@pw.test");
    await access.grantPlatform(admin, "admin");
    const tenantOwner = await mkOperator("towner@pw.test");
    await access.grantTenant(other, tenantOwner, "owner");
    const t = writes(clavix, tenantOwner);
    const asAdmin = as(() => admin);
    expect(codeOf(await asAdmin(t.disableUser))).toBe("FORBIDDEN");
    expect(codeOf(await asAdmin(t.deleteUser))).toBe("FORBIDDEN");
    const enable = `mutation { enableUser(tenantId: "${clavix}", userId: "${tenantOwner}") { active } }`;
    expect((await asAdmin(enable)).errors).toBeUndefined();
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

describe("the last owner of a tenant", () => {
  const operatorOf = async (email: string, tenant: string) => {
    const id = await mkOperator(email);
    await access.grantTenant(tenant, id, "owner");
    return id;
  };

  const fresh = async (slug: string) =>
    (await tenantsService.create({ slug, name: slug })).id;

  test("a platform owner cannot disable or delete the only owner of a tenant", async () => {
    const other = await fresh("pw-solo");
    const sole = await operatorOf("sole@pw.test", other);
    const t = writes(clavix, sole);
    expect(codeOf(await platformOwner(t.disableUser))).toBe("LAST_OWNER");
    expect(codeOf(await platformOwner(t.deleteUser))).toBe("LAST_OWNER");
    // Nothing was changed.
    expect(await access.memberships(sole)).toEqual([
      { tenantId: other, role: "owner" },
    ]);
    const users = await platformOwner(
      `{ user(tenantId: "${clavix}", id: "${sole}") { active } }`,
    );
    expect(users.data).toEqual({ user: { active: true } });
  });

  test("with a second owner, the first may go", async () => {
    const other = await fresh("pw-duo");
    const second = await operatorOf("second@pw.test", other);
    const first = await operatorOf("first@pw.test", other);
    const t = writes(clavix, first);
    expect((await platformOwner(t.disableUser)).errors).toBeUndefined();
    expect((await platformOwner(t.deleteUser)).data).toEqual({
      deleteUser: true,
    });
    // The remaining owner is now the last one.
    const last = writes(clavix, second);
    expect(codeOf(await platformOwner(last.deleteUser))).toBe("LAST_OWNER");
  });

  test("the check runs under the members lock: two owners deleted together keep one", async () => {
    const tenant = await fresh("pw-pair");
    const a = await operatorOf("pair-a@pw.test", tenant);
    const b = await operatorOf("pair-b@pw.test", tenant);
    const results = await Promise.all(
      [a, b].map((id) => platformOwner(writes(clavix, id).deleteUser)),
    );
    expect(results.map(codeOf).sort()).toEqual(["LAST_OWNER", undefined]);
    expect(await access.owners(tenant)).toHaveLength(1);
  });

  test("disabled owners do not count: disabling the second one is refused", async () => {
    const tenant = await fresh("pw-disabled");
    const x = await operatorOf("dis-x@pw.test", tenant);
    const y = await operatorOf("dis-y@pw.test", tenant);
    expect(
      (await platformOwner(writes(clavix, x).disableUser)).errors,
    ).toBeUndefined();
    expect(codeOf(await platformOwner(writes(clavix, y).disableUser))).toBe(
      "LAST_OWNER",
    );
    expect(codeOf(await platformOwner(writes(clavix, y).deleteUser))).toBe(
      "LAST_OWNER",
    );
  });

  test("disabling a disabled sole owner again is idempotent", async () => {
    const tenant = await fresh("pw-twice");
    const sole = await operatorOf("twice@pw.test", tenant);
    const other = await operatorOf("twice-b@pw.test", tenant);
    const t = writes(clavix, sole);
    expect((await platformOwner(t.disableUser)).errors).toBeUndefined();
    // The other owner is gone (revoked behind the console's back): no live
    // owner is left, but `sole` is already disabled.
    await access.revokeTenant(tenant, other, "owner");
    expect((await platformOwner(t.disableUser)).errors).toBeUndefined();
  });

  test("a platform admin is still FORBIDDEN before the last-owner check", async () => {
    const sole = await operatorOf("sole2@pw.test", await fresh("pw-solo2"));
    const admin = await mkOperator("padmin3@pw.test");
    await access.grantPlatform(admin, "admin");
    expect(codeOf(await as(() => admin)(writes(clavix, sole).deleteUser))).toBe(
      "FORBIDDEN",
    );
  });
});
