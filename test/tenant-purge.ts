import { afterAll, beforeEach } from "bun:test";
import {
  janusPartitionedCollections,
  partitionedInvitations,
} from "@softistx/janus-mongo";
import {
  oauthPartitionedCollections,
  purgeMongoOAuthPartition,
} from "@softistx/janus-oauth-mongo";
import { scopeToTenant } from "@softistx/mongo";
import type { Document, ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { createPartitionPurger } from "@/config/partition-purger";
import { ownedPurgers } from "@/config/purge";
import { tenantRetentionService, tenantsService } from "@/config/tenancy";
import { type PartitionPurger, PLATFORM_TENANT_SLUG } from "@/modules/tenants";

export const DAY = 24 * 60 * 60 * 1000;
export const at = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY);

export const real = createPartitionPurger(oauthDb);
export const state: { failFor: string | undefined } = {
  failFor: undefined,
};
// A janus outage half-way: the OAuth part is purged, then the call fails.
export const partitions: PartitionPurger = {
  purgePartition: async (partition) => {
    if (partition === state.failFor) {
      await purgeMongoOAuthPartition(oauthDb, { partition });
      throw new Error("janus down");
    }
    return real.purgePartition(partition);
  },
};
export const logged: string[] = [];
export const run = (now: Date) =>
  tenantRetentionService.purge(
    {
      owned: ownedPurgers(),
      memberships: access,
      partitions,
      log: (message) => logged.push(message),
    },
    now,
  );

// One document per janus collection of the partition (OAuth, stores, signing
// keys, invitations), written raw: the purge reads only `partition`.
/** A raw document of a janus collection: the purge reads only its `partition`. */
interface SeededDoc {
  _id: string;
  partition: string;
}
export const JANUS = [
  ...oauthPartitionedCollections,
  ...janusPartitionedCollections,
  partitionedInvitations,
].map((definition) => definition.name);
// Only what this spec seeded (the other specs share the collections).
export const clearSeeded = async () => {
  for (const name of JANUS)
    await oauthDb
      .collection<SeededDoc>(name)
      .deleteMany({ _id: { $regex: `^[0-9a-f]+:${name}:` } });
};
export const seedJanus = async (partition: string) => {
  for (const name of JANUS) {
    await oauthDb.collection<SeededDoc>(name).insertMany(
      [1].map((n) => ({
        _id: `${partition}:${name}:${n}`,
        partition,
      })),
      { bypassDocumentValidation: true },
    );
  }
};
export const janusOf = async (partition: string) =>
  Object.fromEntries(
    await Promise.all(
      JANUS.map(
        async (name): Promise<[string, Document[]]> => [
          name,
          await oauthDb
            .collection(name)
            .find({ partition })
            .sort({ _id: 1 })
            .toArray(),
        ],
      ),
    ),
  );
export const janusCount = async (partition: string) =>
  Object.values(await janusOf(partition)).reduce(
    (n: number, docs) => n + docs.length,
    0,
  );

export async function seed(slug: string) {
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
export const ownedCount = async (tenant: { _id: ObjectId }) =>
  (await mongo.db.branding.raw.countDocuments({ tenantId: tenant._id })) +
  (await mongo.db.usageCounters.raw.countDocuments({ tenantId: tenant._id }));
export const can = (tenant: { _id: ObjectId }, user: string) =>
  access.can(user, "view", tenant._id.toHexString());

export function useTenantPurgeHooks() {
  beforeEach(async () => {
    logged.length = 0;
    state.failFor = undefined;
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
}
