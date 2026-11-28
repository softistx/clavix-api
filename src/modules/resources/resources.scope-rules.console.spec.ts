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
import { type ConsoleResult, codeOf, consoleAs } from "~/console";
import { defined } from "~/narrow";
import { clientRow, clientRows } from "~/oauth-clients";

const admin = consoleAs("sr-admin");

let tenant = "";

const RENAME = `mutation($t: ID!, $id: ID!, $name: String!) {
  updateScope(tenantId: $t, id: $id, input: { name: $name }) { id name }
}`;
const DELETE = `mutation($t: ID!, $id: ID!) { deleteScope(tenantId: $t, id: $id) }`;
const CREATE_SCOPE = `mutation($t: ID!, $input: CreateScopeInput!) { createScope(tenantId: $t, input: $input) { id } }`;

const scopeNamed = async (name: string) =>
  defined(
    await mongo.db.scopes.raw.findOne({
      tenantId: new ObjectId(tenant),
      name,
    }),
    name,
  )._id.toHexString();
const extensionsOf = (result: ConsoleResult) => result.errors?.[0]?.extensions;
const actions = async () =>
  (await mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray()).map(
    (event) => event["action"],
  );

beforeAll(async () => {
  tenant = (await tenantsService.create({ slug: "sr-a", name: "A" })).id;
  await access.grantTenant(tenant, "sr-admin", "admin");
  await registerStoredResource({
    tenant: "sr-a",
    uri: "https://api.sr-a.example/v1",
    scopes: ["read", "write", "extra", "taken", "dflt"],
  });
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.roles.raw.deleteMany({});
  await mongo.db.resources.raw.deleteMany({});
  await mongo.db.scopes.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("oauthPartitionedClients").deleteMany({});
});

describe("deleteScope", () => {
  test("is refused with PERMISSION_IN_USE and the role ids while a role grants it", async () => {
    const scopeId = await scopeNamed("extra");
    const role = await rolesService.create(new ObjectId(tenant), {
      name: "sr-role",
    });
    const roleId = role._id.toHexString();
    await rolesService.setPermissions(new ObjectId(tenant), roleId, [scopeId]);
    const refused = await admin(DELETE, { t: tenant, id: scopeId });
    expect(codeOf(refused)).toBe("PERMISSION_IN_USE");
    expect(extensionsOf(refused)?.["roles"]).toEqual([roleId]);
    await rolesService.setPermissions(new ObjectId(tenant), roleId, []);
    expect((await admin(DELETE, { t: tenant, id: scopeId })).data).toEqual({
      deleteScope: true,
    });
  });
});

describe("updateScope name", () => {
  test("renames a resource's scope and audits scope.rename", async () => {
    const id = await scopeNamed("read");
    const result = await admin(RENAME, { t: tenant, id, name: "view" });
    expect(result.errors).toBeUndefined();
    expect(result.data?.["updateScope"]).toEqual({ id, name: "view" });
    expect((await actions()).at(-1)).toBe("scope.rename");
  });

  test("is refused with SCOPE_IN_USE and the client ids while a client lists it", async () => {
    const id = await scopeNamed("write");
    await clientRows().insertOne(
      clientRow("sr-client", tenant, { allowedScopes: ["write"] }),
    );
    const refused = await admin(RENAME, { t: tenant, id, name: "edit" });
    expect(codeOf(refused)).toBe("SCOPE_IN_USE");
    expect(extensionsOf(refused)?.["clients"]).toEqual(["sr-client"]);
  });

  test("a client's defaultScopes block it too; another tenant's client does not", async () => {
    const id = await scopeNamed("dflt");
    const clients = clientRows();
    await clients.insertMany([
      clientRow("sr-default", tenant, { defaultScopes: ["dflt"] }),
      clientRow("sr-other", new ObjectId().toHexString(), {
        allowedScopes: ["dflt"],
      }),
    ]);
    const refused = await admin(RENAME, { t: tenant, id, name: "grabbed" });
    expect(codeOf(refused)).toBe("SCOPE_IN_USE");
    expect(extensionsOf(refused)?.["clients"]).toEqual(["sr-default"]);
    await clients.deleteOne({ _id: "sr-default" });
    const renamed = await admin(RENAME, { t: tenant, id, name: "grabbed" });
    expect(renamed.errors).toBeUndefined();
  });

  test("refuses a standard OpenID Connect scope at name", async () => {
    const created = await admin(CREATE_SCOPE, {
      t: tenant,
      input: { name: "openid" },
    });
    const id = at(
      created.data,
      "createScope",
      z.looseObject({ id: z.string() }),
    ).id;
    const refused = await admin(RENAME, { t: tenant, id, name: "oidc" });
    expect(codeOf(refused)).toBe("BAD_USER_INPUT");
    expect(extensionsOf(refused)?.["field"]).toBe("name");
  });

  test("refuses a name the resource already has", async () => {
    const id = await scopeNamed("view");
    const refused = await admin(RENAME, { t: tenant, id, name: "taken" });
    expect(codeOf(refused)).toBe("CONFLICT");
  });
});
