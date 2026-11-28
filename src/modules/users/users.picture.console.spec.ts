import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { avatarObjects } from "@/config/media-objects";
import { profilePoliciesService } from "@/config/profile";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { forTenant } from "@/config/users";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { codeOf, consoleAs } from "~/console";
import { defined } from "~/narrow";

const admin = consoleAs("upc-admin");
const viewer = consoleAs("upc-viewer");

const REMOVE = `mutation($t: ID!, $u: ID!) { removeUserPicture(tenantId: $t, userId: $u) }`;

let tenant = "";
let other = "";
let auth: Awaited<ReturnType<typeof forTenant>> = null;
let holder = "";

const pictureOf = async (id: string) =>
  (await defined(auth).findUser(id))?.avatar ?? null;
const events = () =>
  mongo.db.adminEvents.raw
    .find({ action: "user.removePicture" })
    .sort({ _id: 1 })
    .toArray();

beforeAll(async () => {
  tenant = (await tenantsService.create({ slug: "upc-t", name: "T" })).id;
  other = (await tenantsService.create({ slug: "upc-o", name: "O" })).id;
  await access.grantTenant(tenant, "upc-admin", "admin");
  await access.grantTenant(tenant, "upc-viewer", "viewer");
  const resolved = defined(
    await tenantResolver.resolveHost(`upc-t.${env.CLAVIX_DOMAIN}`),
  );
  auth = await forTenant(resolved);
  holder = (await defined(auth).create({ email: "h@upc.test" })).id;
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.adminEvents.raw.deleteMany({});
});

describe("removeUserPicture", () => {
  test("removes the picture and its object: true, then false on a repeat; audited once", async () => {
    const key = crypto.randomUUID();
    await defined(auth).avatar.set(holder, { id: key });
    const former = spyOn(avatarObjects, "removeFormer");
    try {
      const first = await admin(REMOVE, { t: tenant, u: holder });
      expect(first.errors).toBeUndefined();
      expect(first.data).toEqual({ removeUserPicture: true });
      expect(await pictureOf(holder)).toBeNull();
      expect(former).toHaveBeenCalledWith(tenant, key);
      const again = await admin(REMOVE, { t: tenant, u: holder });
      expect(again.data).toEqual({ removeUserPicture: false });
    } finally {
      former.mockRestore();
    }
    const recorded = await events();
    expect(recorded.map((e) => [e.target.type, e.target.id])).toEqual([
      ["user", holder],
      ["user", holder],
    ]);
  });

  test("an unknown user is NOT_FOUND and nothing is audited", async () => {
    const before = (await events()).length;
    const answer = await admin(REMOVE, { t: tenant, u: "nobody" });
    expect(codeOf(answer)).toBe("NOT_FOUND");
    expect((await events()).length).toBe(before);
  });

  test("a viewer, and another tenant's admin, are refused before anything is read", async () => {
    await defined(auth).avatar.set(holder, { id: crypto.randomUUID() });
    expect(codeOf(await viewer(REMOVE, { t: tenant, u: holder }))).toBe(
      "FORBIDDEN",
    );
    expect(codeOf(await admin(REMOVE, { t: other, u: holder }))).toBe(
      "FORBIDDEN",
    );
    expect(await pictureOf(holder)).not.toBeNull();
  });

  test("a tenant PICTURE lock does not stop an admin", async () => {
    await profilePoliciesService.set(new ObjectId(tenant), ["PICTURE"], 0);
    const answer = await admin(REMOVE, { t: tenant, u: holder });
    expect(answer.errors).toBeUndefined();
    expect(answer.data).toEqual({ removeUserPicture: true });
    expect(await pictureOf(holder)).toBeNull();
  });
});
