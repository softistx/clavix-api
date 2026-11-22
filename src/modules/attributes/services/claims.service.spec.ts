import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  attributesService as catalogue,
  attributeClaimsService as claims,
  roleAttributesService as links,
  attributeValuesService as values,
} from "@/config/attributes";
import { mongo } from "@/config/db";
import { rolesService } from "@/config/roles";
import type { AttributeType } from "../attributes.model";
import type { ValueChange } from "../values.types";

const tenant = new ObjectId();
const other = new ObjectId();
const full = new ObjectId();
const admin = { kind: "admin", id: "admin-1" } as const;
const label = [{ locale: "en", text: "Label" }];
const API = "https://claims.service.test/api";
const OTHER_API = "https://other.claims.service.test/api";
const READ = ["read"];

const make = (
  key: string,
  type: AttributeType = "STRING",
  extra: Record<string, unknown> = {},
) =>
  catalogue.create(tenant, {
    key,
    family: "USER",
    type,
    label,
    emissionScope: "read",
    ...extra,
  });

const roleAttribute = (key: string) =>
  catalogue.create(tenant, {
    key,
    family: "ROLE",
    type: "STRING",
    label,
    emissionScope: "read",
  });

const set = (attributeId: ObjectId, text: string): ValueChange => ({
  attributeId: attributeId.toHexString(),
  value: { text },
});

let apiId = new ObjectId();

beforeAll(async () => {
  for (const tenantId of [tenant, other, full])
    await mongo.db.scopes.create({ tenantId, name: "read", description: [] });
  apiId = (
    await mongo.db.resources.create({ tenantId: tenant, uri: API, name: "api" })
  )._id;
  await mongo.db.resources.create({
    tenantId: tenant,
    uri: OTHER_API,
    name: "other",
  });
});

afterAll(async () => {
  for (const tenantId of [tenant, other, full]) {
    await mongo.db.roleAttributes.raw.deleteMany({ tenantId });
    await mongo.db.attributeValues.raw.deleteMany({ tenantId });
    await mongo.db.userAttributes.raw.deleteMany({ tenantId });
    await mongo.db.roleAssignments.raw.deleteMany({ tenantId });
    await mongo.db.roles.raw.deleteMany({ tenantId });
    await mongo.db.resources.raw.deleteMany({ tenantId });
    await mongo.db.scopes.raw.deleteMany({ tenantId });
  }
});

describe("what a token carries", () => {
  test("a live attribute with a value and its scope is a claim", async () => {
    const nick = await make("nick");
    await values.save(tenant, "u-live", [set(nick._id, "bob")], admin, true);
    expect(await claims.claimsFor(tenant, "u-live", READ, null)).toEqual({
      nick: "bob",
    });
  });

  test("no claim without the scope, with none, or for a user without the value", async () => {
    const note = await make("note", "STRING", { emissionScope: null });
    const scoped = await make("scoped");
    await values.save(
      tenant,
      "u-scope",
      [set(note._id, "x"), set(scoped._id, "y")],
      admin,
      true,
    );
    expect(await claims.claimsFor(tenant, "u-scope", ["openid"], null)).toEqual(
      {},
    );
    expect(await claims.claimsFor(tenant, "u-scope", [], null)).toEqual({});
    expect(await claims.claimsFor(tenant, "u-scope", READ, null)).toEqual({
      scoped: "y",
    });
    expect(await claims.claimsFor(tenant, "u-nobody", READ, null)).toEqual({});
  });

  test("an archived attribute is never emitted, and is again once restored", async () => {
    const old = await make("old");
    await values.save(tenant, "u-old", [set(old._id, "z")], admin, true);
    await catalogue.archive(tenant, old.id);
    expect(await claims.claimsFor(tenant, "u-old", READ, null)).toEqual({});
    await catalogue.restore(tenant, old.id);
    expect(await claims.claimsFor(tenant, "u-old", READ, null)).toEqual({
      old: "z",
    });
  });

  test("another tenant's attributes and values are never read", async () => {
    expect(await claims.claimsFor(other, "u-live", READ, null)).toEqual({});
  });
});

describe("the scope table", () => {
  test("lists the live attributes by emission scope, and follows an archive", async () => {
    const table = await make("tabled");
    const quiet = await make("untabled", "STRING", { emissionScope: null });
    expect(await claims.scopeClaims(tenant)).toMatchObject({
      read: expect.arrayContaining(["tabled"]),
    });
    expect((await claims.scopeClaims(tenant))["read"]).not.toContain(
      "untabled",
    );
    await catalogue.archive(tenant, table.id);
    expect((await claims.scopeClaims(tenant))["read"] ?? []).not.toContain(
      "tabled",
    );
    await catalogue.archive(tenant, quiet.id);
  });

  test("another tenant's attributes are never listed", async () => {
    expect(await claims.scopeClaims(other)).toEqual({});
  });
});

describe("a role attribute", () => {
  test("is emitted by a tenant-wide role for every audience, by a resource role for its own", async () => {
    const wideAttr = await roleAttribute("wide");
    const scopedAttr = await roleAttribute("scoped_role");
    const wide = await rolesService.create(tenant, { name: "c-wide" });
    const onApi = await rolesService.create(tenant, {
      name: "c-api",
      resourceId: apiId.toHexString(),
    });
    await links.assign(tenant, wide.id, wideAttr.id, false);
    await links.assign(tenant, onApi.id, scopedAttr.id, false);
    for (const role of [wide, onApi])
      await rolesService.assign(tenant, role.id, "u-role");
    await values.save(
      tenant,
      "u-role",
      [set(wideAttr._id, "w"), set(scopedAttr._id, "s")],
      admin,
      false,
      {
        family: "ROLE",
        links: new Map([
          [wideAttr.id, false],
          [scopedAttr.id, false],
        ]),
      },
    );
    expect(await claims.claimsFor(tenant, "u-role", READ, API)).toEqual({
      wide: "w",
      scoped_role: "s",
    });
    expect(await claims.claimsFor(tenant, "u-role", READ, OTHER_API)).toEqual({
      wide: "w",
    });
    expect(await claims.claimsFor(tenant, "u-role", READ, null)).toEqual({
      wide: "w",
    });
    await rolesService.unassign(tenant, wide.id, "u-role");
    expect(await claims.claimsFor(tenant, "u-role", READ, API)).toEqual({
      scoped_role: "s",
    });
  });
});

describe("the size of a token", () => {
  test("100 emitted STRING values (a tenant's whole catalogue) stay under 8 KiB", async () => {
    const changes: ValueChange[] = [];
    for (let index = 0; index < 100; index += 1) {
      const attribute = await catalogue.create(full, {
        key: `size_${String(index).padStart(3, "0")}`,
        family: "USER",
        type: "STRING",
        label,
        emissionScope: "read",
      });
      changes.push(set(attribute._id, `A typical value ${index}, 40 chars.`));
    }
    await values.save(full, "u-size", changes, admin, true);
    const emitted = await claims.claimsFor(full, "u-size", READ, null);
    expect(Object.keys(emitted)).toHaveLength(100);
    expect(JSON.stringify(emitted).length).toBeLessThan(8 * 1024);
  });
});
