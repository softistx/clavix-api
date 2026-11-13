import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  janusPartitionedCollections,
  partitionedInvitations,
} from "@softistx/janus-mongo";
import {
  oauthPartitionedCollections,
  purgeMongoOAuthPartition,
} from "@softistx/janus-oauth-mongo";
import { scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { createPartitionPurger } from "@/config/partition-purger";
import { ownedPurgers } from "@/config/purge";
import { tenantAdmin, tenantsService } from "@/config/tenancy";
import { type PartitionPurger, purgeTenants } from "./purge";
import { PLATFORM_TENANT_SLUG } from "./slug";
import { SlugTakenError } from "./tenants.errors";
import { purgeAtOf } from "./trash.schema";

const DAY = 24 * 60 * 60 * 1000;
const at = (date: Date, days: number) => new Date(date.getTime() + days * DAY);

const real = createPartitionPurger(oauthDb);
let failFor: string | undefined;
// A janus outage half-way: the OAuth part is purged, then the call fails.
const partitions: PartitionPurger = {
  purgePartition: async (partition) => {
    if (partition === failFor) {
      await purgeMongoOAuthPartition(oauthDb, { partition });
      throw new Error("janus down");
    }
    return real.purgePartition(partition);
  },
};
const logged: string[] = [];
const run = (now: Date) =>
  purgeTenants(
    {
      registry: tenantAdmin,
      owned: ownedPurgers(),
      memberships: access,
      partitions,
      log: (message) => logged.push(message),
    },
    now,
  );

// One document per janus collection of the partition (OAuth, stores, signing
// keys, invitations), written raw: the purge reads only `partition`.
const JANUS = [
  ...oauthPartitionedCollections,
  ...janusPartitionedCollections,
  partitionedInvitations,
].map((definition) => definition.name);
// Only what this spec seeded (the other specs share the collections).
const clearSeeded = async () => {
  for (const name of JANUS)
    await oauthDb
      .collection(name)
      .deleteMany({ _id: { $regex: `^[0-9a-f]+:${name}:` } as never });
};
const seedJanus = async (partition: string) => {
  for (const name of JANUS) {
    await oauthDb.collection(name).insertMany(
      [1].map((n) => ({
        _id: `${partition}:${name}:${n}`,
        partition,
      })) as never[],
      { bypassDocumentValidation: true },
    );
  }
};
const janusOf = async (partition: string) =>
  Object.fromEntries(
    await Promise.all(
      JANUS.map(async (name) => [
        name,
        await oauthDb
          .collection(name)
          .find({ partition })
          .sort({ _id: 1 })
          .toArray(),
      ]),
    ),
  );
const janusCount = async (partition: string) =>
  Object.values(await janusOf(partition)).reduce(
    (n: number, docs) => n + (docs as unknown[]).length,
    0,
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
  await seedJanus(tenant._id.toHexString());
  return tenant;
}
const ownedCount = async (tenant: { _id: ObjectId }) =>
  (await mongo.db.branding.raw.countDocuments({ tenantId: tenant._id })) +
  (await mongo.db.usageCounters.raw.countDocuments({ tenantId: tenant._id }));
const can = (tenant: { _id: ObjectId }, user: string) =>
  access.can(user, "view", tenant._id.toHexString());

beforeEach(async () => {
  logged.length = 0;
  failFor = undefined;
  await clearSeeded();
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
  await clearSeeded();
});

describe("the tenant purge", () => {
  test("never touches adminEvents, which is a platform collection", () => {
    const names = ownedPurgers().map((p) => p.name);
    expect(names).toContain("branding");
    expect(names).toContain("usageCounters");
    // The roles and their assignments are tenant-owned: purged with it.
    expect(names).toContain("roles");
    expect(names).toContain("roleAssignments");
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
    expect(await janusCount(a._id.toHexString())).toBeGreaterThanOrEqual(
      JANUS.length,
    );
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
    const bBefore = await janusOf(b._id.toHexString());

    expect(await run(due)).toEqual({
      purged: [a._id.toHexString()],
      failed: [],
    });
    // A's partition is empty in every janus collection, with the counts logged.
    expect(await janusCount(a._id.toHexString())).toBe(0);
    expect(logged.join("\n")).toContain('"clients":1');
    expect(logged.join("\n")).toContain('"users":1');
    expect(logged.join("\n")).toContain('"invitations":1');
    expect(logged.join("\n")).toMatch(/"signingKeys":[1-9]/);
    // B's partition is untouched, document for document.
    expect(await janusOf(b._id.toHexString())).toEqual(bBefore);
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
    // The OAuth part went before the outage; the users are still there.
    expect(await janusCount(id)).toBeGreaterThan(0);
    // Claimed: it resolves nowhere and cannot be restored.
    await expect(tenantAdmin.restore(id)).rejects.toThrow();
    failFor = undefined;
    expect(await run(due)).toEqual({ purged: [id], failed: [] });
    expect(await ownedCount(a)).toBe(0);
    expect(await janusCount(id)).toBe(0);
  });

  test("a tenant deleted 29 days ago is left alone, whole", async () => {
    const a = await seed("alpha");
    const id = a._id.toHexString();
    const trashed = await tenantAdmin.trash(id);
    const before = await janusOf(id);
    expect(await run(at(trashed.deletedAt as Date, 29))).toEqual({
      purged: [],
      failed: [],
    });
    expect(await janusOf(id)).toEqual(before);
    expect(await ownedCount(a)).toBe(2);
    expect(await can(a, "user-alpha")).toBe(true);
  });

  test("a restored tenant, and a live or suspended one, are never purged", async () => {
    const restored = await seed("alpha");
    const live = await seed("bravo");
    const paused = await seed("charlie");
    await tenantsService.suspend(paused._id.toHexString());
    const trashed = await tenantAdmin.trash(restored._id.toHexString());
    await tenantAdmin.restore(restored._id.toHexString());
    const far = at(trashed.deletedAt as Date, 400);
    expect(await run(far)).toEqual({ purged: [], failed: [] });
    for (const tenant of [restored, live, paused]) {
      expect(await janusCount(tenant._id.toHexString())).toBeGreaterThanOrEqual(
        JANUS.length,
      );
      expect(await ownedCount(tenant)).toBe(2);
    }
  });

  test("refuses the default partition and an empty one, touching nothing", async () => {
    await seedJanus("default");
    const before = await janusOf("default");
    await expect(real.purgePartition("default")).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(real.purgePartition("")).rejects.toBeInstanceOf(TypeError);
    expect(await janusOf("default")).toEqual(before);
  });
});
