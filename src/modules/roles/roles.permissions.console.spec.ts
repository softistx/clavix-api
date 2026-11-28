import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource } from "@/config/resources";
import { rolesService } from "@/config/roles";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { at } from "~/body";
import { codeOf, consoleAs } from "~/console";
import { defined } from "~/narrow";

const admin = consoleAs("rp-admin-a");
const viewer = consoleAs("rp-viewer-a");
const adminB = consoleAs("rp-admin-b");

let tenantA = "";
let tenantB = "";
let resourceA = "";

const CREATE = `mutation($t: ID!, $input: CreateRoleInput!) { createRole(tenantId: $t, input: $input) { id } }`;
const SET_PERMISSIONS = `mutation($t: ID!, $r: ID!, $p: [ID!]!) {
  setRolePermissions(tenantId: $t, roleId: $r, permissionIds: $p) { id permissions { id name resourceId } }
}`;
const PERMISSIONS = `query($t: ID!, $id: ID!) { role(tenantId: $t, id: $id) { permissions { name } } }`;
const DELETE_RESOURCE = `mutation($t: ID!, $id: ID!) { deleteResource(tenantId: $t, id: $id) }`;

const make = async (who: typeof admin, tenant: string, name: string) => {
  const result = await who(CREATE, { t: tenant, input: { name } });
  expect(result.errors).toBeUndefined();
  return at(result.data, "createRole", z.looseObject({ id: z.string() })).id;
};
const events = () =>
  mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray();

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "rp-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "rp-b", name: "B" })).id;
  await access.grantTenant(tenantA, "rp-admin-a", "admin");
  await access.grantTenant(tenantA, "rp-viewer-a", "viewer");
  await access.grantTenant(tenantB, "rp-admin-b", "admin");
  await registerStoredResource({
    tenant: "rp-a",
    uri: "https://api.rp-a.example/v1",
    scopes: ["read"],
  });
  resourceA = defined(
    await mongo.db.resources.raw.findOne({ tenantId: new ObjectId(tenantA) }),
    "the resource",
  )._id.toHexString();
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.roles.raw.deleteMany({});
  await mongo.db.roleAssignments.raw.deleteMany({});
  await mongo.db.resources.raw.deleteMany({});
  await mongo.db.scopes.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  for (const name of ["partitionedUsers", "partitionedSessions", "relations"]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("setRolePermissions", () => {
  const scopeIds = async (resource: string) =>
    (
      await mongo.db.scopes.raw
        .find({ resourceId: new ObjectId(resource) })
        .sort({ name: 1 })
        .toArray()
    ).map((scope) => scope._id.toHexString());
  const permissionsOf = async (id: string) =>
    at(
      (await viewer(PERMISSIONS, { t: tenantA, id })).data,
      "role.permissions",
      z.array(z.looseObject({ name: z.string() })),
    ).map((scope) => scope.name);

  test("an admin sets, replaces and clears the permissions; a viewer cannot", async () => {
    const [read] = await scopeIds(resourceA);
    const id = await make(admin, tenantA, "perm-set");
    const set = await admin(SET_PERMISSIONS, {
      t: tenantA,
      r: id,
      p: [read, read],
    });
    expect(set.errors).toBeUndefined();
    expect(set.data?.["setRolePermissions"]).toMatchObject({
      id,
      permissions: [{ id: read, name: "read", resourceId: resourceA }],
    });
    expect(await permissionsOf(id)).toEqual(["read"]);
    expect(
      codeOf(await viewer(SET_PERMISSIONS, { t: tenantA, r: id, p: [] })),
    ).toBe("FORBIDDEN");
    expect(
      (await admin(SET_PERMISSIONS, { t: tenantA, r: id, p: [] })).errors,
    ).toBeUndefined();
    expect(await permissionsOf(id)).toEqual([]);
    expect((await events()).map((e) => e["action"]).at(-1)).toBe(
      "role.setPermissions",
    );
  });

  test("refuses at the breaching index, a managed role and another tenant's role", async () => {
    const [read] = await scopeIds(resourceA);
    const id = await make(admin, tenantA, "perm-bad");
    const bad = await admin(SET_PERMISSIONS, {
      t: tenantA,
      r: id,
      p: [read, new ObjectId().toHexString()],
    });
    expect(codeOf(bad)).toBe("BAD_USER_INPUT");
    expect(bad.errors?.[0]?.extensions?.["field"]).toBe("permissionIds.1");
    const malformed = await admin(SET_PERMISSIONS, {
      t: tenantA,
      r: id,
      p: ["x"],
    });
    expect(codeOf(malformed)).toBe("BAD_USER_INPUT");
    expect(malformed.errors?.[0]?.extensions?.["field"]).toBe(
      "permissionIds.0",
    );
    const managed = await rolesService.create(new ObjectId(tenantA), {
      name: "perm-managed",
      managed: true,
    });
    expect(
      codeOf(
        await admin(SET_PERMISSIONS, {
          t: tenantA,
          r: managed._id.toHexString(),
          p: [],
        }),
      ),
    ).toBe("ROLE_MANAGED");
    expect(
      codeOf(await adminB(SET_PERMISSIONS, { t: tenantB, r: id, p: [read] })),
    ).toBe("NOT_FOUND");
  });

  test("deleting a resource pulls its scopes out of tenant-wide roles and records it", async () => {
    await registerStoredResource({
      tenant: "rp-a",
      uri: "https://api.rp-a.example/gone",
      scopes: ["gone:read"],
    });
    const gone = defined(
      await mongo.db.resources.raw.findOne({
        tenantId: new ObjectId(tenantA),
        uri: "https://api.rp-a.example/gone",
      }),
      "the resource",
    )._id.toHexString();
    const [kept] = await scopeIds(resourceA);
    const [dropped] = await scopeIds(gone);
    const id = await make(admin, tenantA, "perm-cascade");
    await admin(SET_PERMISSIONS, { t: tenantA, r: id, p: [kept, dropped] });
    expect(await permissionsOf(id)).toEqual(["gone:read", "read"]);
    await mongo.db.adminEvents.raw.deleteMany({});
    expect(
      (await admin(DELETE_RESOURCE, { t: tenantA, id: gone })).errors,
    ).toBeUndefined();
    expect(await permissionsOf(id)).toEqual(["read"]);
    expect(
      (await events()).filter((e) => e["action"] === "role.setPermissions"),
    ).toHaveLength(1);
  });

  test("re-registering a resource without a scope pulls it from the roles that hold it and records it", async () => {
    const uri = "https://api.rp-a.example/replace";
    await registerStoredResource({
      tenant: "rp-a",
      uri,
      scopes: ["keep", "drop"],
    });
    const replaced = defined(
      await mongo.db.resources.raw.findOne({
        tenantId: new ObjectId(tenantA),
        uri,
      }),
      "the resource",
    )._id.toHexString();
    const [drop, keep] = await scopeIds(replaced);
    const id = await make(admin, tenantA, "perm-replace");
    await admin(SET_PERMISSIONS, { t: tenantA, r: id, p: [keep, drop] });
    expect(await permissionsOf(id)).toEqual(["drop", "keep"]);
    await mongo.db.adminEvents.raw.deleteMany({});
    await registerStoredResource({ tenant: "rp-a", uri, scopes: ["keep"] });
    expect(await permissionsOf(id)).toEqual(["keep"]);
    const recorded = (await events()).filter(
      (e) => e["action"] === "role.setPermissions",
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actor: "script:resources:create",
      target: { type: "role", id },
    });
  });
});
