import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const admin = consoleAs("upf-admin");
const viewer = consoleAs("upf-viewer");
const stranger = consoleAs("upf-stranger");

let tenant = "";
let other = "";
let user = "";
let bystander = "";

const PROFILE = `profile { givenName familyName nickname phone { number verified } locale zoneinfo birthdate address { formatted streetAddress locality region postalCode country } pictureKey updatedAt }`;
const UPDATE = `mutation($t: ID!, $u: ID!, $input: UpdateUserInput!) { updateUser(tenantId: $t, userId: $u, input: $input) { name ${PROFILE} } }`;
const VERIFY = `mutation($t: ID!, $u: ID!, $v: Boolean!) { setUserPhoneVerified(tenantId: $t, userId: $u, verified: $v) { ${PROFILE} } }`;
const READ = `query($t: ID!, $id: ID!) { user(tenantId: $t, id: $id) { name ${PROFILE} } }`;

const update = (input: Record<string, unknown>, id = user) =>
  admin(UPDATE, { t: tenant, u: id, input });
const read = async (id = user) => {
  const answer = await admin(READ, { t: tenant, id });
  expect(answer.errors).toBeUndefined();
  return defined(
    at(answer.data, "user", z.looseObject({ profile: z.looseObject({}) })),
  );
};
const events = () =>
  mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray();

beforeAll(async () => {
  tenant = (await tenantsService.create({ slug: "upf-t", name: "T" })).id;
  other = (await tenantsService.create({ slug: "upf-o", name: "O" })).id;
  await access.grantTenant(tenant, "upf-admin", "admin");
  await access.grantTenant(tenant, "upf-viewer", "viewer");
  const resolved = defined(
    await tenantResolver.resolveHost(`upf-t.${env.CLAVIX_DOMAIN}`),
  );
  const auth = defined(await forTenant(resolved));
  user = (await auth.create({ email: "a@upf.test", name: "A" })).id;
  bystander = (await auth.create({ email: "b@upf.test", name: "B" })).id;
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.adminEvents.raw.deleteMany({});
});

describe("a user with no profile", () => {
  test("shows every field null and no picture", async () => {
    const found = await read(bystander);
    expect(found["profile"]).toMatchObject({
      givenName: null,
      familyName: null,
      nickname: null,
      phone: null,
      locale: null,
      zoneinfo: null,
      birthdate: null,
      address: null,
      pictureKey: null,
    });
  });
});

describe("updateUser with profile fields", () => {
  test("stores each field, normalised, and reads them back", async () => {
    const done = await update({
      name: "  Ada L  ",
      givenName: " Ada ",
      familyName: "Lovelace",
      nickname: "Ad",
      phone: "+1 (416) 555-0123",
      locale: "fr-ca",
      zoneinfo: "america/toronto",
      birthdate: "1990-12-10",
      address: {
        streetAddress: "1 rue X",
        locality: "Montreal",
        postalCode: "H1A 1A1",
        country: "ca",
      },
    });
    expect(done.errors).toBeUndefined();
    const found = await read();
    expect(found).toMatchObject({
      name: "Ada L",
      profile: {
        givenName: "Ada",
        familyName: "Lovelace",
        nickname: "Ad",
        phone: { number: "+14165550123", verified: false },
        locale: "fr-CA",
        zoneinfo: "America/Toronto",
        birthdate: "1990-12-10",
        address: {
          streetAddress: "1 rue X",
          locality: "Montreal",
          postalCode: "H1A 1A1",
          country: "CA",
          formatted: null,
          region: null,
        },
      },
    });
  });

  test("a field left out is kept; null and a blank text clear", async () => {
    expect((await update({ nickname: "Ada2" })).errors).toBeUndefined();
    expect(await read()).toMatchObject({
      name: "Ada L",
      profile: { givenName: "Ada", nickname: "Ada2", locale: "fr-CA" },
    });
    expect(
      (await update({ givenName: null, familyName: "  ", address: null }))
        .errors,
    ).toBeUndefined();
    expect(await read()).toMatchObject({
      profile: {
        givenName: null,
        familyName: null,
        address: null,
        nickname: "Ada2",
      },
    });
    expect(
      (await update({ address: { locality: "" } })).errors,
    ).toBeUndefined();
  });

  test("refuses a malformed field with PROFILE_FIELD_INVALID and stores nothing", async () => {
    const before = await read();
    for (const input of [
      { phone: "4165550123" },
      { locale: "not a tag" },
      { zoneinfo: "Mars/Olympus" },
      { birthdate: "2999-01-01" },
      { birthdate: "1999-02-29" },
      { address: { country: "ZZ" } },
      { nickname: "x".repeat(101) },
      // A good field beside a bad one is not stored either.
      { givenName: "Zed", phone: "12" },
    ]) {
      expect(codeOf(await update(input))).toBe("PROFILE_FIELD_INVALID");
    }
    expect(await read()).toEqual(before);
  });

  test("a name that is blank or over 200 characters is BAD_USER_INPUT", async () => {
    expect(codeOf(await update({ name: "  " }))).toBe("BAD_USER_INPUT");
    expect(codeOf(await update({ name: "x".repeat(201) }))).toBe(
      "BAD_USER_INPUT",
    );
  });

  test("the name refusal names the `name` field", async () => {
    for (const name of ["  ", "x".repeat(201)]) {
      const answer = await update({ name });
      expect(answer.errors?.[0]?.extensions?.field).toBe("name");
    }
  });

  test("an unknown user is NOT_FOUND; a viewer and a stranger cannot write", async () => {
    expect(codeOf(await update({ nickname: "x" }, "nobody"))).toBe("NOT_FOUND");
    const args = { t: tenant, u: user, input: { nickname: "x" } };
    expect(codeOf(await viewer(UPDATE, args))).toBe("FORBIDDEN");
    expect(codeOf(await stranger(UPDATE, args))).toBe("FORBIDDEN");
  });

  test("another tenant's admin cannot reach the user", async () => {
    await access.grantTenant(other, "upf-admin-o", "admin");
    const foreign = consoleAs("upf-admin-o");
    const answer = await foreign(UPDATE, {
      t: other,
      u: user,
      input: { nickname: "x" },
    });
    expect(codeOf(answer)).toBe("NOT_FOUND");
    expect((await read()).profile).toMatchObject({ nickname: "Ada2" });
  });

  test("is recorded as user.update with ids only", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    await update({ nickname: "Secret-nick", phone: "+14165550999" });
    const recorded = await events();
    expect(recorded.map((e) => e.action)).toEqual(["user.update"]);
    expect(recorded[0]?.target).toMatchObject({ type: "user", id: user });
    expect(JSON.stringify(recorded)).not.toContain("Secret-nick");
    expect(JSON.stringify(recorded)).not.toContain("4165550999");
  });
});

describe("the phone and its verified flag", () => {
  test("only an admin marks it verified; a repeat is a no-op", async () => {
    await update({ phone: "+14165550123" });
    expect((await read()).profile).toMatchObject({
      phone: { number: "+14165550123", verified: false },
    });
    const marked = await admin(VERIFY, { t: tenant, u: user, v: true });
    expect(marked.errors).toBeUndefined();
    expect(marked.data).toMatchObject({
      setUserPhoneVerified: { profile: { phone: { verified: true } } },
    });
    const again = await admin(VERIFY, { t: tenant, u: user, v: true });
    expect(again.errors).toBeUndefined();
  });

  test("saving the same number keeps the flag; a different one resets it; clearing drops it", async () => {
    await update({ phone: "+1 416 555 0123" });
    expect((await read()).profile).toMatchObject({
      phone: { number: "+14165550123", verified: true },
    });
    await update({ phone: "+14165550177" });
    expect((await read()).profile).toMatchObject({
      phone: { number: "+14165550177", verified: false },
    });
    await admin(VERIFY, { t: tenant, u: user, v: true });
    await update({ nickname: "other field" });
    expect((await read()).profile).toMatchObject({
      phone: { verified: true },
    });
    await update({ phone: null });
    expect((await read()).profile).toMatchObject({ phone: null });
  });

  test("a user with no phone cannot be marked: PROFILE_FIELD_INVALID", async () => {
    expect(
      codeOf(await admin(VERIFY, { t: tenant, u: bystander, v: true })),
    ).toBe("PROFILE_FIELD_INVALID");
  });

  test("an unknown user is NOT_FOUND; a viewer cannot; the call is recorded", async () => {
    expect(
      codeOf(await admin(VERIFY, { t: tenant, u: "nobody", v: true })),
    ).toBe("NOT_FOUND");
    expect(codeOf(await viewer(VERIFY, { t: tenant, u: user, v: true }))).toBe(
      "FORBIDDEN",
    );
    await update({ phone: "+14165550123" });
    await mongo.db.adminEvents.raw.deleteMany({});
    await admin(VERIFY, { t: tenant, u: user, v: true });
    const recorded = await events();
    expect(recorded.map((e) => e.action)).toEqual(["user.setPhoneVerified"]);
    expect(recorded[0]?.target).toMatchObject({ type: "user", id: user });
  });
});
