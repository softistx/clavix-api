import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { codeOf, consoleAs } from "~/console";

// ADR-0039: a suspended tenant's console stays readable by its admins, every
// write of theirs is TENANT_SUSPENDED (the guard), the platform's own
// suspend / resume / delete / restore still work, the trash is NOT_FOUND.
const owner = consoleAs("sus-owner");
const admin = consoleAs("sus-admin");
const viewer = consoleAs("sus-viewer");
const operator = consoleAs("sus-operator");

let tenant = "";

const READS: Record<string, string> = {
  tenant: `query($t: ID!) { tenant(id: $t) { id status } }`,
  usage: `query($t: ID!) { usage(tenantId: $t) { tenantId } }`,
  clients: `query($t: ID!) { clients(tenantId: $t) { items { id } } }`,
  resources: `query($t: ID!) { resources(tenantId: $t) { id } }`,
  scopes: `query($t: ID!) { scopes(tenantId: $t) { id } }`,
  roles: `query($t: ID!) { roles(tenantId: $t) { id } }`,
  users: `query($t: ID!) { users(tenantId: $t) { items { id } } }`,
  userInvitations: `query($t: ID!) { userInvitations(tenantId: $t) { id } }`,
  memberships: `query($t: ID!) { memberships(tenantId: $t) { role } }`,
  adminInvitations: `query($t: ID!) { adminInvitations(tenantId: $t) { id } }`,
  domains: `query($t: ID!) { domains(tenantId: $t) { id } }`,
  branding: `query($t: ID!) { branding(tenantId: $t) { tenantId } }`,
  signInPolicy: `query($t: ID!) { signInPolicy(tenantId: $t) { tenantId } }`,
};

const WRITES: Record<string, string> = {
  updateTenant: `mutation($t: ID!) { updateTenant(id: $t, input: { name: "X" }) { id } }`,
  createClient: `mutation($t: ID!) { createClient(tenantId: $t, input: { name: "C", type: PUBLIC, redirectUris: ["https://a.example/cb"] }) { client { id } } }`,
  deleteClient: `mutation($t: ID!) { deleteClient(tenantId: $t, id: "c") }`,
  createResource: `mutation($t: ID!) { createResource(tenantId: $t, input: { uri: "https://r.example" }) { id } }`,
  createRole: `mutation($t: ID!) { createRole(tenantId: $t, input: { name: "r" }) { id } }`,
  inviteUser: `mutation($t: ID!) { inviteUser(tenantId: $t, email: "u@example.com") { id } }`,
  disableUser: `mutation($t: ID!) { disableUser(tenantId: $t, userId: "u") { id } }`,
  addDomain: `mutation($t: ID!) { addDomain(tenantId: $t, host: "sus.example.com") { id } }`,
  updateBranding: `mutation($t: ID!) { updateBranding(tenantId: $t, input: { displayName: "S", seed: "#336699" }) { changed } }`,
  updateSignInMethods: `mutation($t: ID!) { updateSignInMethods(tenantId: $t, methods: []) { tenantId } }`,
  inviteAdmin: `mutation($t: ID!) { inviteAdmin(tenantId: $t, email: "a@example.com", role: VIEWER) { id } }`,
  removeMembership: `mutation($t: ID!) { removeMembership(tenantId: $t, userId: "sus-viewer") }`,
};

const MANAGE = new Set(["inviteAdmin", "removeMembership"]);

beforeAll(async () => {
  tenant = (await tenantsService.create({ slug: "sus-a", name: "A" })).id;
  await access.grantTenant(tenant, "sus-owner", "owner");
  await access.grantTenant(tenant, "sus-admin", "admin");
  await access.grantTenant(tenant, "sus-viewer", "viewer");
  await access.grantPlatform("sus-operator", "owner");
  await tenantsService.suspend(tenant);
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("a suspended tenant's reads", () => {
  for (const [name, query] of Object.entries(READS)) {
    test(`${name} works for its admin, its viewer and an operator`, async () => {
      for (const as of [admin, viewer, operator]) {
        const result = await as(query, { t: tenant });
        expect(result.errors).toBeUndefined();
      }
    });
  }

  test("the tenant exposes its status", async () => {
    const result = await admin(READS["tenant"] as string, { t: tenant });
    expect(result.data?.["tenant"]).toEqual({
      id: tenant,
      status: "SUSPENDED",
    });
  });

  test("me lists it, with its status", async () => {
    const result = await admin(
      `{ me { memberships { tenant { id status } role } } }`,
    );
    expect(result.data?.["me"]).toEqual({
      memberships: [
        { tenant: { id: tenant, status: "SUSPENDED" }, role: "ADMIN" },
      ],
    });
  });
});

describe("a suspended tenant's writes", () => {
  for (const [name, query] of Object.entries(WRITES)) {
    test(`${name} is TENANT_SUSPENDED for its admin`, async () => {
      expect(codeOf(await owner(query, { t: tenant }))).toBe(
        "TENANT_SUSPENDED",
      );
      // Membership calls need `manage`: an admin is FORBIDDEN there already.
      if (!MANAGE.has(name)) {
        expect(codeOf(await admin(query, { t: tenant }))).toBe(
          "TENANT_SUSPENDED",
        );
      }
    });
  }

  test("a viewer stays FORBIDDEN (the role is checked first)", async () => {
    expect(
      codeOf(await viewer(WRITES["createRole"] as string, { t: tenant })),
    ).toBe("FORBIDDEN");
  });

  test("the error is a 403 with no write done", async () => {
    const result = await admin(WRITES["updateTenant"] as string, { t: tenant });
    expect(result.errors?.[0]?.message).toBe("The tenant is suspended");
    expect((await tenantsService.activeByIds([tenant])).length).toBe(0);
    const read = await admin(READS["tenant"] as string, { t: tenant });
    expect(read.data?.["tenant"]).toMatchObject({ status: "SUSPENDED" });
  });

  test("an operator's update still goes through", async () => {
    const result = await operator(WRITES["updateTenant"] as string, {
      t: tenant,
    });
    expect(result.errors).toBeUndefined();
  });
});

describe("the platform's own tenant calls", () => {
  test("resume works, then the admin writes again; suspend, delete and restore work", async () => {
    const op = (name: string) =>
      operator(`mutation($t: ID!) { ${name}(id: $t) { status } }`, {
        t: tenant,
      });
    expect((await op("resumeTenant")).data?.["resumeTenant"]).toEqual({
      status: "ACTIVE",
    });
    const wrote = await admin(WRITES["createRole"] as string, { t: tenant });
    expect(wrote.errors).toBeUndefined();
    expect((await op("suspendTenant")).data?.["suspendTenant"]).toEqual({
      status: "SUSPENDED",
    });
    expect((await op("deleteTenant")).data?.["deleteTenant"]).toEqual({
      status: "DELETED",
    });
    expect((await op("restoreTenant")).data?.["restoreTenant"]).toEqual({
      status: "SUSPENDED",
    });
  });
});

describe("a deleted tenant", () => {
  test("stays NOT_FOUND on every module for its admin", async () => {
    await operator(`mutation($t: ID!) { deleteTenant(id: $t) { id } }`, {
      t: tenant,
    });
    for (const name of [
      "usage",
      "clients",
      "resources",
      "roles",
      "users",
      "memberships",
      "domains",
      "signInPolicy",
    ]) {
      expect([
        name,
        codeOf(await admin(READS[name] as string, { t: tenant })),
      ]).toEqual([name, "NOT_FOUND"]);
    }
    expect(
      (await admin(READS["tenant"] as string, { t: tenant })).data,
    ).toEqual({ tenant: null });
    await operator(`mutation($t: ID!) { restoreTenant(id: $t) { id } }`, {
      t: tenant,
    });
  });
});
