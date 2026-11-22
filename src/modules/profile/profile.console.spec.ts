import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { codeOf, consoleAs } from "~/console";

const admin = consoleAs("pfp-admin");
const viewer = consoleAs("pfp-viewer");
const stranger = consoleAs("pfp-stranger");

let tenant = "";
let other = "";

const READ = `query($t: ID!) { profilePolicy(tenantId: $t) { tenantId locked version updatedAt } }`;
const SET = `mutation($t: ID!, $l: [ProfileField!]!, $v: Int!) { updateProfilePolicy(tenantId: $t, locked: $l, version: $v) { tenantId locked version updatedAt } }`;

const tenantVersion = async () =>
  (await mongo.db.tenants.raw.findOne({ _id: new ObjectId(tenant) }))?.version;

beforeAll(async () => {
  tenant = (await tenantsService.create({ slug: "pfp-t", name: "T" })).id;
  other = (await tenantsService.create({ slug: "pfp-o", name: "O" })).id;
  await access.grantTenant(tenant, "pfp-admin", "admin");
  await access.grantTenant(tenant, "pfp-viewer", "viewer");
  await access.grantTenant(other, "pfp-admin-o", "admin");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.profilePolicies.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
});

describe("profilePolicy", () => {
  test("reads as nothing locked while the tenant set none", async () => {
    const answer = await viewer(READ, { t: tenant });
    expect(answer.errors).toBeUndefined();
    expect(answer.data).toEqual({
      profilePolicy: {
        tenantId: tenant,
        locked: [],
        version: 0,
        updatedAt: null,
      },
    });
  });

  test("a stranger and an unknown tenant are FORBIDDEN", async () => {
    expect(codeOf(await stranger(READ, { t: tenant }))).toBe("FORBIDDEN");
    expect(codeOf(await admin(READ, { t: "nope" }))).toBe("FORBIDDEN");
  });
});

describe("updateProfilePolicy", () => {
  test("stores the locks, never bumps the tenant version, and is audited with ids only", async () => {
    const before = await tenantVersion();
    await mongo.db.adminEvents.raw.deleteMany({});
    const answer = await admin(SET, {
      t: tenant,
      l: ["PHONE", "NICKNAME"],
      v: 0,
    });
    expect(answer.errors).toBeUndefined();
    expect(answer.data).toMatchObject({
      updateProfilePolicy: { tenantId: tenant, version: 1 },
    });
    const locked = (await viewer(READ, { t: tenant })).data;
    expect(locked).toMatchObject({
      profilePolicy: {
        version: 1,
        locked: expect.arrayContaining(["PHONE", "NICKNAME"]),
      },
    });
    expect(await tenantVersion()).toBe(before);
    const recorded = await mongo.db.adminEvents.raw.find({}).toArray();
    expect(recorded.map((e) => e.action)).toEqual(["profilePolicy.update"]);
    expect(recorded[0]?.target).toMatchObject({
      type: "profilePolicy",
      id: tenant,
    });
  });

  test("a stale version is CONFLICT and changes nothing", async () => {
    expect(codeOf(await admin(SET, { t: tenant, l: [], v: 0 }))).toBe(
      "CONFLICT",
    );
    expect((await viewer(READ, { t: tenant })).data).toMatchObject({
      profilePolicy: { version: 1 },
    });
    expect(
      (await admin(SET, { t: tenant, l: [], v: 1 })).errors,
    ).toBeUndefined();
  });

  test("a viewer and a stranger cannot write", async () => {
    const args = { t: tenant, l: ["PHONE"], v: 2 };
    expect(codeOf(await viewer(SET, args))).toBe("FORBIDDEN");
    expect(codeOf(await stranger(SET, args))).toBe("FORBIDDEN");
  });

  test("tenants are isolated", async () => {
    const foreign = consoleAs("pfp-admin-o");
    expect(codeOf(await foreign(READ, { t: tenant }))).toBe("FORBIDDEN");
    expect(codeOf(await foreign(SET, { t: tenant, l: [], v: 2 }))).toBe(
      "FORBIDDEN",
    );
    expect((await foreign(READ, { t: other })).data).toMatchObject({
      profilePolicy: { version: 0, locked: [] },
    });
  });
});
