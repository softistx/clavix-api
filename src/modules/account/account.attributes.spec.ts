import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { attributesService } from "@/config/attributes";
import { mongo } from "@/config/db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { clearJanus, codeOf, gql, signedIn } from "~/account-session";
import { createTenantParOff } from "~/tenant-par-off";

const SLUG = "acct-attrs";
const ME = `{ currentUser { lockedFields profile { givenName } attributes { attribute { key } text } } }`;
const SET = `mutation ($values: [MyAttributeValueInput!]!) {
  setMyAttributeValues(values: $values) { attribute { id key } text }
}`;

let tenantId: Awaited<ReturnType<typeof createTenantParOff>>["_id"];
const label = [{ locale: "en", text: "Label" }];
const attribute = (key: string, userEditable: boolean) =>
  attributesService.create(tenantId, {
    key,
    family: "USER",
    type: "STRING",
    label,
    userEditable,
  });

beforeAll(async () => {
  const tenant = await createTenantParOff(tenantsService, {
    slug: SLUG,
    name: SLUG,
    signUp: true,
  });
  tenantId = tenant._id;
}, 300_000);

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.userAttributes.raw.deleteMany({ tenantId });
  await mongo.db.attributeValues.raw.deleteMany({ tenantId });
  await clearJanus();
});

describe("setMyAttributeValues", () => {
  test("sets the user-editable attributes only, and lists them with their values", async () => {
    const open = await attribute("acct_nick", true);
    const closed = await attribute("acct_grade", false);
    const me = await signedIn(SLUG);
    const refused = await gql(
      SLUG,
      SET,
      {
        values: [
          { attributeId: open._id.toHexString(), value: { text: "a" } },
          { attributeId: closed._id.toHexString(), value: { text: "b" } },
        ],
      },
      me.cookie,
    );
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe("ATTRIBUTE_NOT_EDITABLE");
    expect(refused.errors?.[0]?.extensions?.field).toBe("values.1");
    const none = await gql(SLUG, ME, {}, me.cookie);
    expect(none.data).toMatchObject({
      currentUser: {
        attributes: [{ attribute: { key: "acct_nick" }, text: null }],
      },
    });
    const saved = await gql(
      SLUG,
      SET,
      {
        values: [{ attributeId: open._id.toHexString(), value: { text: "a" } }],
      },
      me.cookie,
    );
    expect(saved.data).toMatchObject({
      setMyAttributeValues: [{ attribute: { key: "acct_nick" }, text: "a" }],
    });
    const cleared = await gql(
      SLUG,
      SET,
      { values: [{ attributeId: open._id.toHexString(), value: null }] },
      me.cookie,
    );
    expect(cleared.data).toMatchObject({
      setMyAttributeValues: [{ text: null }],
    });
  });

  test("is never blocked by `required`", async () => {
    const needed = await attributesService.create(tenantId, {
      key: "acct_needed",
      family: "USER",
      type: "STRING",
      label,
      userEditable: true,
      required: true,
    });
    const me = await signedIn(SLUG);
    const answer = await gql(
      SLUG,
      SET,
      { values: [{ attributeId: needed._id.toHexString(), value: null }] },
      me.cookie,
    );
    expect(answer.status).toBe(200);
  });

  test("is 401 without a session", async () => {
    expect(codeOf(await gql(SLUG, SET, { values: [] }))).toBe(
      "UNAUTHENTICATED",
    );
  });
});
