import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { ownedPurgers } from "@/config/purge";
import { tenantAdmin, tenantsService } from "@/config/tenancy";
import { type PartitionPurger, purgeTenants } from "./purge";
import { PLATFORM_TENANT_SLUG } from "./slug";
import { SlugTakenError } from "./tenants.errors";
import { purgeAtOf } from "./trash.schema";

const DAY = 24 * 60 * 60 * 1000;
const at = (date: Date, days: number) => new Date(date.getTime() + days * DAY);

const purged: string[] = [];
let failFor: string | undefined;
const partitions: PartitionPurger = {
  purgePartition: async (partition) => {
    if (partition === failFor) throw new Error("janus down");
    purged.push(partition);
  },
};
const run = (now: Date) =>
  purgeTenants(
    {
      registry: tenantAdmin,
      owned: ownedPurgers(),
      memberships: access,
      partitions,
      log: () => {},
    },
    now,
  );

async function seed(slug: string) {
  const tenant = await tenantsService.create({ slug, name: `${slug} Inc` });
  const scoped = scopeToTenant(mongo.db.branding, tenant._id);
  await scoped.create({
    displayName: slug,
    seed: "#112233",
    radius: "0.5rem",
    css: "",
  });
  await scopeToTenant(mongo.db.usageCounters, tenant._id).create({
    month: "2026-11",
    mau: 3,
  });
  await access.grantTenant(tenant._id.toHexString(), `user-${slug}`, "admin");
  await access.linkTenant(tenant._id.toHexString());
  return tenant;
}
const ownedCount = async (tenant: { _id: ObjectId }) =>
  (await mongo.db.branding.raw.countDocuments({ tenantId: tenant._id })) +
  (await mongo.db.usageCounters.raw.countDocuments({ tenantId: tenant._id }));
const can = (tenant: { _id: ObjectId }, user: string) =>
  access.can(user, "view", tenant._id.toHexString());

beforeEach(async () => {
  purged.length = 0;
  failFor = undefined;
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.branding.raw.deleteMany({});
  await mongo.db.usageCounters.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
});
afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.branding.raw.deleteMany({});
  await mongo.db.usageCounters.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("the tenant purge", () => {
  test("never touches adminEvents, which is a platform collection", () => {
    const names = ownedPurgers().map((p) => p.name);
    expect(names).toContain("branding");
    expect(names).toContain("usageCounters");
    expect(names).toContain("domains");
    expect(names).not.toContain("adminEvents");
  });

  test("every purger reaches a real collection", async () => {
    for (const purger of ownedPurgers()) {
      expect(await purger.deleteOwnedBy(new ObjectId())).toBe(0);
    }
  });

  test("refuses a tenant before its purgeAt and a tenant not in the trash", async () => {
    const a = await seed("alpha");
    await seed("bravo"); // not deleted
    const trashed = await tenantAdmin.trash(a._id.toHexString());
    const due = purgeAtOf(trashed.deletedAt as Date);
    expect(await run(at(due, -1))).toEqual({ purged: [], failed: [] });
    expect(purged).toEqual([]);
    expect(await ownedCount(a)).toBe(2);
    expect(
      (await tenantAdmin.find(a._id.toHexString()))?.purgeStartedAt,
    ).toBeUndefined();
  });

  test("purges tenant A at purgeAt and leaves tenant B whole", async () => {
    const a = await seed("alpha");
    const b = await seed("bravo");
    await mongo.db.adminEvents.raw.insertOne({
      _id: new ObjectId(),
      actor: "op",
      action: "tenant.delete",
      tenantId: a._id,
      target: { type: "tenant", id: a._id.toHexString() },
      at: new Date(),
      requestId: "r",
    } as never);
    const trashed = await tenantAdmin.trash(a._id.toHexString());
    const due = purgeAtOf(trashed.deletedAt as Date);

    expect(await run(due)).toEqual({
      purged: [a._id.toHexString()],
      failed: [],
    });
    expect(purged).toEqual([a._id.toHexString()]);
    // A: documents, roles and platform link gone.
    expect(await ownedCount(a)).toBe(0);
    expect(await can(a, "user-alpha")).toBe(false);
    // B: untouched.
    expect(await ownedCount(b)).toBe(2);
    expect(await can(b, "user-bravo")).toBe(true);
    // The audit trail of A stays.
    expect(
      await mongo.db.adminEvents.raw.countDocuments({ tenantId: a._id }),
    ).toBe(1);
    // The tombstone keeps the slug, and the tenant is gone for everyone.
    const tomb = await mongo.db.tenants.raw.findOne({ _id: a._id });
    expect(tomb).toMatchObject({ slug: "alpha", name: "" });
    expect(tomb?.["purgedAt"]).toBeInstanceOf(Date);
    expect(await tenantAdmin.find(a._id.toHexString())).toBeUndefined();
    await expect(
      tenantsService.create({ slug: "alpha", name: "again" }),
    ).rejects.toBeInstanceOf(SlugTakenError);
    expect(
      (await tenantAdmin.list({ first: 50 })).items.map((t) => t.slug),
    ).not.toContain("alpha");
    // A second run finds nothing to do.
    expect(await run(due)).toEqual({ purged: [], failed: [] });
  });

  test("a purge that failed is resumed by the next run, and cannot be restored meanwhile", async () => {
    const a = await seed("alpha");
    const id = a._id.toHexString();
    const trashed = await tenantAdmin.trash(id);
    const due = purgeAtOf(trashed.deletedAt as Date);
    failFor = id;
    expect(await run(due)).toEqual({ purged: [], failed: [id] });
    expect(await ownedCount(a)).toBe(2);
    // Claimed: it resolves nowhere and cannot be restored.
    await expect(tenantAdmin.restore(id)).rejects.toThrow();
    failFor = undefined;
    expect(await run(due)).toEqual({ purged: [id], failed: [] });
    expect(await ownedCount(a)).toBe(0);
  });
});
