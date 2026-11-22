import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { forTenant } from "@/config/users";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { at } from "~/body";
import { codeOf, consoleAs } from "~/console";
import { defined } from "~/narrow";

const admin = consoleAs("uav-admin");
const viewer = consoleAs("uav-viewer");
const stranger = consoleAs("uav-stranger");

let tenant = "";
let userA = "";
let userB = "";
let nameKey = "";

const CREATE = `mutation($t: ID!, $input: CreateUserAttributeInput!) { createUserAttribute(tenantId: $t, input: $input) { id key } }`;
const SET = `mutation($t: ID!, $u: ID!, $s: AttributeSectionInput!, $v: [AttributeValueInput!]!) { setUserAttributeValues(tenantId: $t, userId: $u, section: $s, values: $v) { general { attribute { key valueCount } text number boolean options } roles { role { id } } } }`;
const USER = `query($t: ID!, $id: ID!) { user(tenantId: $t, id: $id) { attributesComplete attributes { general { attribute { key } text number } } } }`;

const label = [{ locale: "en", text: "Label" }];
const make = async (key: string, extra: Record<string, unknown> = {}) => {
  const result = await admin(CREATE, {
    t: tenant,
    input: { key, family: "USER", type: "STRING", label, ...extra },
  });
  expect(result.errors).toBeUndefined();
  return at(
    result.data,
    "createUserAttribute",
    z.looseObject({ id: z.string() }),
  ).id;
};
const set = (user: string, values: unknown[]) =>
  admin(SET, { t: tenant, u: user, s: {}, v: values });
const events = () =>
  mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray();

beforeAll(async () => {
  tenant = (await tenantsService.create({ slug: "uav-t", name: "T" })).id;
  await access.grantTenant(tenant, "uav-admin", "admin");
  await access.grantTenant(tenant, "uav-viewer", "viewer");
  const resolved = defined(
    await tenantResolver.resolveHost(`uav-t.${env.CLAVIX_DOMAIN}`),
  );
  const auth = defined(await forTenant(resolved));
  userA = (await auth.create({ email: "a@uav.test", name: "A" })).id;
  userB = (await auth.create({ email: "b@uav.test", name: "B" })).id;
  nameKey = await make("pseudo", { required: true });
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.userAttributes.raw.deleteMany({});
  await mongo.db.attributeValues.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  await mongo.db.roleAssignments.raw.deleteMany({});
  await mongo.db.roles.raw.deleteMany({});
});

describe("setUserAttributeValues", () => {
  test("sets, reads back through the user, and flags a complete profile", async () => {
    const nick = nameKey;
    const age = await make("age", { type: "NUMBER", unique: true });
    const done = await set(userA, [
      { attributeId: nick, value: { text: "Ada" } },
      { attributeId: age, value: { number: 36 } },
    ]);
    expect(done.errors).toBeUndefined();
    const read = await admin(USER, { t: tenant, id: userA });
    expect(read.data).toMatchObject({
      user: {
        attributesComplete: true,
        attributes: {
          general: [
            { attribute: { key: "pseudo" }, text: "Ada", number: null },
            { attribute: { key: "age" }, text: null, number: 36 },
          ],
        },
      },
    });
    const other = await admin(USER, { t: tenant, id: userB });
    expect(other.data).toMatchObject({ user: { attributesComplete: false } });
  });

  test("refuses a clear of a required value, a taken unique value and a role section", async () => {
    const age = await make("age2", { type: "NUMBER", unique: true });
    await set(userA, [{ attributeId: age, value: { number: 7 } }]);
    const taken = await set(userB, [
      { attributeId: age, value: { number: 7 } },
    ]);
    expect(codeOf(taken)).toBe("ATTRIBUTE_VALUE_TAKEN");
    const cleared = await set(userA, [{ attributeId: nameKey, value: null }]);
    expect(codeOf(cleared)).toBe("ATTRIBUTE_REQUIRED");
    const role = await admin(SET, {
      t: tenant,
      u: userA,
      s: { roleId: new ObjectId().toHexString() },
      v: [],
    });
    expect(codeOf(role)).toBe("ATTRIBUTE_ROLE_NOT_HELD");
    const bad = await set(userA, [{ attributeId: age, value: { text: "x" } }]);
    expect(codeOf(bad)).toBe("ATTRIBUTE_VALUE_INVALID");
  });

  test("an unknown user is NOT_FOUND; a viewer and a stranger cannot write", async () => {
    expect(codeOf(await set("nobody", []))).toBe("NOT_FOUND");
    const args = { t: tenant, u: userA, s: {}, v: [] };
    expect(codeOf(await viewer(SET, args))).toBe("FORBIDDEN");
    expect(codeOf(await stranger(SET, args))).toBe("FORBIDDEN");
  });

  test("is recorded as user.setAttributes with ids only", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    const age = await make("age3", { type: "NUMBER" });
    await mongo.db.adminEvents.raw.deleteMany({});
    await set(userA, [{ attributeId: age, value: { number: 99 } }]);
    const recorded = await events();
    expect(recorded.map((e) => e.action)).toEqual(["user.setAttributes"]);
    expect(recorded[0]?.target).toEqual({ type: "user", id: userA });
    expect(JSON.stringify(recorded)).not.toContain("99");
  });
});
