import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { attributesService } from "@/config/attributes";
import { mongo } from "@/config/db";
import { profilePoliciesService } from "@/config/profile";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import {
  type Answer,
  clearJanus,
  codeOf,
  gql,
  janusOf,
  signedIn,
} from "~/account-session";
import { at } from "~/body";
import { createTenantParOff } from "~/tenant-par-off";

const SLUG = "acct-profile";
const UPDATE = `mutation ($input: UpdateMyProfileInput!) {
  updateMyProfile(input: $input) {
    name
    profile { givenName nickname locale phone { number verified } address { locality country } }
  }
}`;
const ME = `{ currentUser { lockedFields profile { givenName } attributes { attribute { key } text } } }`;
const SET = `mutation ($values: [MyAttributeValueInput!]!) {
  setMyAttributeValues(values: $values) { attribute { id key } text }
}`;

const updated = (answer: Answer) =>
  at(
    answer.data,
    "updateMyProfile",
    z.looseObject({
      name: z.string().nullable(),
      profile: z.looseObject({
        givenName: z.string().nullable(),
        phone: z
          .object({ number: z.string(), verified: z.boolean() })
          .nullable(),
      }),
    }),
  );

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
  await mongo.db.profilePolicies.raw.deleteMany({ tenantId });
  await clearJanus();
});

describe("updateMyProfile", () => {
  test("changes the name and the standard fields and answers the user", async () => {
    const me = await signedIn(SLUG);
    const answer = await gql(
      SLUG,
      UPDATE,
      {
        input: {
          name: "  Ada Lovelace ",
          givenName: "Ada",
          nickname: "ada",
          locale: "fr-fr",
          address: { locality: "Paris", country: "fr" },
        },
      },
      me.cookie,
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(updated(answer)?.name).toBe("Ada Lovelace");
    const stored = await (await janusOf(SLUG)).findUser(me.user.id);
    expect(stored?.givenName).toBe("Ada");
    expect(stored?.locale).toBe("fr-FR");
    expect(stored?.address).toEqual({ locality: "Paris", country: "FR" });
  });

  test("is 401 without a session and 400 for an invalid value, writing nothing", async () => {
    expect(codeOf(await gql(SLUG, UPDATE, { input: { givenName: "A" } }))).toBe(
      "UNAUTHENTICATED",
    );
    const me = await signedIn(SLUG);
    const bad = await gql(
      SLUG,
      UPDATE,
      { input: { givenName: "Grace", phone: "not a phone" } },
      me.cookie,
    );
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe("PROFILE_FIELD_INVALID");
    expect(
      (await (await janusOf(SLUG)).findUser(me.user.id))?.givenName,
    ).toBeUndefined();
    const blank = await gql(SLUG, UPDATE, { input: { name: " " } }, me.cookie);
    expect(codeOf(blank)).toBe("BAD_USER_INPUT");
  });

  test("a changed phone becomes unverified, the same number keeps its flag", async () => {
    const me = await signedIn(SLUG);
    const auth = await janusOf(SLUG);
    await auth.update(
      me.user,
      { phone: { number: "+14165550123", verified: true } },
      { ifVersion: me.user.version },
    );
    const same = await gql(
      SLUG,
      UPDATE,
      { input: { phone: "+1 416 555 0123" } },
      me.cookie,
    );
    expect(updated(same)?.profile.phone).toEqual({
      number: "+14165550123",
      verified: true,
    });
    const changed = await gql(
      SLUG,
      UPDATE,
      { input: { phone: "+14165550199" } },
      me.cookie,
    );
    expect(updated(changed)?.profile.phone).toEqual({
      number: "+14165550199",
      verified: false,
    });
  });

  test("a locked field is PROFILE_FIELD_LOCKED, 403, and nothing is written; the others stay editable", async () => {
    await profilePoliciesService.set(tenantId, ["PHONE", "NAME"], 0);
    try {
      const me = await signedIn(SLUG);
      const refused = await gql(
        SLUG,
        UPDATE,
        { input: { givenName: "Grace", phone: "+14165550123" } },
        me.cookie,
      );
      expect(refused.status).toBe(403);
      expect(codeOf(refused)).toBe("PROFILE_FIELD_LOCKED");
      expect(refused.errors?.[0]?.extensions?.field).toBe("PHONE");
      const name = await gql(SLUG, UPDATE, { input: { name: "X" } }, me.cookie);
      expect(codeOf(name)).toBe("PROFILE_FIELD_LOCKED");
      const stored = await (await janusOf(SLUG)).findUser(me.user.id);
      expect(stored?.givenName).toBeUndefined();
      expect(stored?.phone ?? null).toBeNull();
      const open = await gql(
        SLUG,
        UPDATE,
        { input: { givenName: "Grace" } },
        me.cookie,
      );
      expect(updated(open)?.profile.givenName).toBe("Grace");
      const lists = await gql(SLUG, ME, {}, me.cookie);
      expect(lists.data).toMatchObject({
        currentUser: { lockedFields: ["NAME", "PHONE"] },
      });
    } finally {
      await mongo.db.profilePolicies.raw.deleteMany({ tenantId });
    }
  });
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
