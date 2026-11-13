import type { ObjectId } from "mongodb";
import type { Tenant } from "./tenants.model";

/**
 * Removes what a tenant's janus partition holds: users, sessions, passkeys,
 * invitations, OAuth clients, grants and tokens, and the signing keys.
 * Resumable (a second call removes what the first left) and idempotent.
 *
 * Temporary, until @softistx/janus-oauth-mongo#710 (softistx/nxgt-janus#710):
 * janus cannot purge a partition yet, so there is no implementation, and the
 * job is not scheduled. The wiring is clavix-api#112.
 */
export interface PartitionPurger {
  purgePartition(partition: string): Promise<void>;
}

/** One tenant-owned collection of the app, reached through the tenancy helpers (`tenantOwned`). */
export interface OwnedCollectionPurger {
  name: string;
  /** Removes every document the tenant owns; the number removed. */
  deleteOwnedBy(tenantId: ObjectId): Promise<number>;
}

/** What the purge needs of the tenants' registry (`TenantAdminService`). */
export interface PurgeRegistry {
  purgeDue(now: Date): Promise<Tenant[]>;
  claimPurge(tenant: Tenant, now: Date): Promise<boolean>;
  markPurged(tenant: Tenant, now: Date): Promise<void>;
}

export interface PurgeDeps {
  registry: PurgeRegistry;
  /** The app's tenant-owned collections: `tenantOwned(collections)`, never a platform one (`adminEvents` stays). */
  owned: readonly OwnedCollectionPurger[];
  /** The tenant's roles and platform link in the console's permissions. */
  memberships: { removeTenant(tenantId: string): Promise<unknown> };
  partitions: PartitionPurger;
  log?: (message: string) => void;
}

export interface PurgeReport {
  /** Hex ids of the tenants whose purge ended. */
  purged: string[];
  /** Hex ids of the tenants whose purge stopped on an error; the next run resumes them. */
  failed: string[];
}

/**
 * Purges the tenants whose 30 days of trash are over at `now`. Each tenant:
 * claimed (it resolves nowhere and cannot be restored from then on), its
 * partition, its tenant-owned collections and its memberships removed, then
 * the tombstone (`slug`, `deletedAt`, `purgedAt`) keeps the slug reserved. A
 * tenant that fails is left claimed and resumed by the next run; the others
 * go on. Refuses a tenant before its `purgeAt` (`claimPurge` says no).
 */
export async function purgeTenants(
  deps: PurgeDeps,
  now: Date = new Date(),
): Promise<PurgeReport> {
  const log = deps.log ?? ((message) => console.warn(message));
  const report: PurgeReport = { purged: [], failed: [] };
  for (const tenant of await deps.registry.purgeDue(now)) {
    const id = tenant._id.toHexString();
    try {
      if (!(await deps.registry.claimPurge(tenant, now))) continue;
      await deps.partitions.purgePartition(id);
      for (const collection of deps.owned) {
        await collection.deleteOwnedBy(tenant._id);
      }
      await deps.memberships.removeTenant(id);
      await deps.registry.markPurged(tenant, now);
      report.purged.push(id);
    } catch (error) {
      report.failed.push(id);
      log(
        `tenants: purge of ${id} stopped, the next run resumes it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return report;
}
