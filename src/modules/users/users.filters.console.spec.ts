import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { access } from "@/config/access";
import { attributesService, attributeValuesService } from "@/config/attributes";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { rolesService } from "@/config/roles";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { forTenant } from "@/config/users";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { at } from "~/body";
import { codeOf, consoleAs } from "~/console";
import { defined } from "~/narrow";

const admin = consoleAs("ufc-admin");

const USERS = `query($t: ID!, $first: Int, $after: String, $prefix: String, $role: ID, $attrs: [AttributeFilterInput!]) { users(tenantId: $t, first: $first, after: $after, emailPrefix: $prefix, roleId: $role, attributes: $attrs) { items { id email } nextCursor totalCount } }`;
const page = z.looseObject({
  items: z.array(z.looseObject({ email: z.string() })),
  nextCursor: z.string().nullable(),
  totalCount: z.number(),
});

const label = [{ locale: "en", text: "Label" }];
const actor = { kind: "admin", id: "ufc-admin" } as const;
let tenant = "";
let tenantId = new ObjectId();
let roleId = "";
let colour = "";
const emails = ["ann@ufc.test", "anna@ufc.test", "bob@ufc.test", "cy@ufc.test"];

const list = async (variables: Record<string, unknown>) => {
  const result = await admin(USERS, { t: tenant, ...variables });
  expect(result.errors).toBeUndefined();
  const read = at(result.data, "users", page);
  return { ...read, emails: read.items.map((item) => item.email) };
};
const filter = (...options: string[]) => [{ attributeId: colour, options }];

beforeAll(async () => {
  tenant = (await tenantsService.create({ slug: "ufc-t", name: "T" })).id;
  tenantId = new ObjectId(tenant);
  await access.grantTenant(tenant, "ufc-admin", "admin");
  const resolved = defined(
    await tenantResolver.resolveHost(`ufc-t.${env.CLAVIX_DOMAIN}`),
  );
  const auth = defined(await forTenant(resolved));
  const ids: string[] = [];
  for (const email of emails) {
    ids.push((await auth.create({ email, name: email })).id);
  }
  const attribute = await attributesService.create(tenantId, {
    key: "ufc_colour",
    family: "USER",
    type: "SELECT",
    label,
    options: ["red", "blue"].map((key) => ({ key, label })),
  });
  colour = attribute._id.toHexString();
  const role = await rolesService.create(tenantId, { name: "ufc-role" });
  roleId = role.id;
  for (const [index, id] of ids.entries()) {
    await attributeValuesService.save(
      tenantId,
      id,
      [
        {
          attributeId: colour,
          value: { options: [index < 3 ? "red" : "blue"] },
        },
      ],
      actor,
      false,
    );
  }
  for (const id of ids.slice(0, 2))
    await rolesService.assign(tenantId, roleId, id);
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.userAttributes.raw.deleteMany({});
  await mongo.db.attributeValues.raw.deleteMany({});
  await mongo.db.roleAssignments.raw.deleteMany({});
  await mongo.db.roles.raw.deleteMany({});
});

describe("users filters", () => {
  test("a role and an attribute narrow the list, and totalCount follows", async () => {
    const holders = await list({ role: roleId });
    expect(holders.emails.sort()).toEqual(["ann@ufc.test", "anna@ufc.test"]);
    expect(holders.totalCount).toBe(2);
    const red = await list({ attrs: filter("red") });
    expect(red.totalCount).toBe(3);
    const both = await list({ role: roleId, attrs: filter("blue") });
    expect(both).toMatchObject({ emails: [], totalCount: 0 });
  });

  test("combines with emailPrefix", async () => {
    const found = await list({ prefix: "ann", attrs: filter("red") });
    expect(found.emails.sort()).toEqual(["ann@ufc.test", "anna@ufc.test"]);
    expect(found.totalCount).toBe(2);
    const none = await list({ prefix: "bob", role: roleId });
    expect(none).toMatchObject({ emails: [], totalCount: 0 });
  });

  test("pages with a stable cursor", async () => {
    const first = await list({ first: 2, attrs: filter("red") });
    expect(first.items).toHaveLength(2);
    expect(first.totalCount).toBe(3);
    const cursor = defined(first.nextCursor);
    const second = await list({
      first: 2,
      after: cursor,
      attrs: filter("red"),
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.totalCount).toBe(3);
    const seen = [...first.emails, ...second.emails];
    expect(new Set(seen).size).toBe(3);
  });

  test("answers BAD_USER_INPUT for more than 5 filters, a bad cursor and a bad option", async () => {
    const many = Array.from({ length: 6 }, () => filter("red")[0]);
    const tooMany = await admin(USERS, { t: tenant, attrs: many });
    expect(codeOf(tooMany)).toBe("BAD_USER_INPUT");
    const cursor = await admin(USERS, {
      t: tenant,
      after: "nope",
      role: roleId,
    });
    expect(codeOf(cursor)).toBe("BAD_USER_INPUT");
    const option = await admin(USERS, { t: tenant, attrs: filter("green") });
    expect(codeOf(option)).toBe("BAD_USER_INPUT");
  });

  test("without a filter the list is the unfiltered one", async () => {
    const everyone = await list({});
    expect(everyone.totalCount).toBeGreaterThanOrEqual(4);
  });
});
