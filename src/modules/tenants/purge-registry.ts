import type { TypedCollection } from "@softistx/mongo";
import type { Tenant, tenants } from "./tenants.model";
import { purgeCutoff } from "./trash.schema";

/** The three writes of the purge, over the tenants collection. */
export interface PurgeRegistry {
  purgeDue(now: Date): Promise<Tenant[]>;
  claimPurge(tenant: Tenant, now: Date): Promise<boolean>;
  markPurged(tenant: Tenant, now: Date): Promise<void>;
}

/** `changed` drops the tenant's hosts from the resolver's cache after a write. */
export function createPurgeRegistry(
  collection: TypedCollection<typeof tenants>,
  changed: (tenant: Pick<Tenant, "slug" | "_id">) => Promise<void> | void,
): PurgeRegistry {
  return {
    /** The tenants whose 30 days are over at `now`, a purge left unfinished included. */
    purgeDue(now) {
      return collection.findMany({
        filter: {
          deletedAt: { $lte: purgeCutoff(now) },
          purgedAt: { $exists: false },
        },
        withDeleted: true,
      });
    },

    /**
     * Claims the tenant for the purge: from here it resolves nowhere and cannot
     * be restored. `false` when it is not in the trash, not due at `now`, or
     * already purged; claiming again an unfinished purge is `true` (a resume).
     */
    async claimPurge(tenant, now) {
      const result = await collection.raw.updateOne(
        {
          _id: tenant._id,
          deletedAt: { $ne: null, $lte: purgeCutoff(now) },
          purgedAt: { $exists: false },
        },
        { $set: { purgeStartedAt: now }, $inc: { version: 1 } },
      );
      if (result.matchedCount === 0) return false;
      await changed(tenant);
      return true;
    },

    /**
     * Ends a purge: what stays is the tombstone (the slug, `deletedAt`,
     * `purgedAt`), which keeps the slug reserved for ever through the unique
     * index. The name goes with the data.
     */
    async markPurged(tenant, now) {
      await collection.raw.updateOne(
        { _id: tenant._id, purgeStartedAt: { $exists: true } },
        {
          $set: { purgedAt: now, name: "", signUp: false, quotaOverrides: {} },
          $inc: { version: 1 },
        },
      );
    },
  };
}
