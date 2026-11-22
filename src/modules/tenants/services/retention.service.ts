import type { TypedCollection } from "@softistx/mongo";
import type { Tenant, tenants } from "../tenants.model";
import type { PlanId } from "../tenants.plan";
import { purgeCutoff } from "../tenants.trash";
import type {
  PurgeDeps,
  PurgeReport,
  TenantHostsOptions,
} from "../tenants.types";
import { dropHosts, partitionOf, reasonOf } from "../tenants.utils";

/**
 * What outlives a tenant's deletion (owner, 2026-11-20: one service per
 * domain): the plan its logs follow until their retention ends (D16), and the
 * purge of the trash after 30 days.
 */
export class TenantRetentionService {
  constructor(
    private readonly collection: TypedCollection<typeof tenants>,
    private readonly options: TenantHostsOptions,
  ) {}

  /**
   * Every tenant with its plan, the suspended, the trashed and the purged
   * included: their logs follow the plan until the retention ends (D16).
   */
  async retentionTargets(): Promise<{ id: string; plan: PlanId }[]> {
    const all = await this.collection.findMany({ withDeleted: true });
    return all.map((tenant) => ({
      id: partitionOf(tenant._id),
      plan: tenant.plan,
    }));
  }

  /** The tenants whose 30 days are over at `now`, a purge left unfinished included. */
  purgeDue(now: Date): Promise<Tenant[]> {
    return this.collection.findMany({
      filter: {
        deletedAt: { $lte: purgeCutoff(now) },
        purgedAt: { $exists: false },
      },
      withDeleted: true,
    });
  }

  /**
   * Claims the tenant for the purge: from here it resolves nowhere and cannot
   * be restored. `false` when it is not in the trash, not due at `now`, or
   * already purged; claiming again an unfinished purge is `true` (a resume).
   */
  async claimPurge(tenant: Tenant, now: Date): Promise<boolean> {
    const result = await this.collection.raw.updateOne(
      {
        _id: tenant._id,
        deletedAt: { $ne: null, $lte: purgeCutoff(now) },
        purgedAt: { $exists: false },
      },
      { $set: { purgeStartedAt: now }, $inc: { version: 1 } },
    );
    if (result.matchedCount === 0) return false;
    await dropHosts(this.options, tenant);
    return true;
  }

  /**
   * Ends a purge: what stays is the tombstone (the slug, `deletedAt`,
   * `purgedAt`), which keeps the slug reserved for ever through the unique
   * index. The name goes with the data.
   */
  async markPurged(tenant: Tenant, now: Date): Promise<void> {
    await this.collection.raw.updateOne(
      { _id: tenant._id, purgeStartedAt: { $exists: true } },
      {
        $set: { purgedAt: now, name: "", signUp: false, quotaOverrides: {} },
        $inc: { version: 1 },
      },
    );
  }

  /**
   * Purges the tenants whose 30 days of trash are over at `now`. Each tenant:
   * claimed (it resolves nowhere and cannot be restored from then on), its
   * partition, its tenant-owned collections and its memberships removed, then
   * the tombstone (`slug`, `deletedAt`, `purgedAt`) keeps the slug reserved. A
   * tenant that fails is left claimed and resumed by the next run; the others
   * go on. Refuses a tenant before its `purgeAt` (`claimPurge` says no).
   */
  async purge(deps: PurgeDeps, now: Date): Promise<PurgeReport> {
    const report: PurgeReport = { purged: [], failed: [] };
    for (const tenant of await this.purgeDue(now)) {
      const id = tenant._id.toHexString();
      try {
        if (!(await this.claimPurge(tenant, now))) continue;
        await this.remove(tenant, deps);
        await this.markPurged(tenant, now);
        report.purged.push(id);
      } catch (error) {
        report.failed.push(id);
        deps.log(
          `tenants: purge of ${id} stopped, the next run resumes it: ${reasonOf(error)}`,
        );
      }
    }
    return report;
  }

  /** What a claimed tenant owns, removed: its janus partition, its collections, its memberships. */
  private async remove(tenant: Tenant, deps: PurgeDeps): Promise<void> {
    const id = tenant._id.toHexString();
    const counts = await deps.partitions.purgePartition(id);
    deps.log(
      `tenants: purged the partition of ${id}: ${JSON.stringify(counts)}`,
    );
    for (const owned of deps.owned) await owned.deleteOwnedBy(tenant._id);
    await deps.memberships.removeTenant(id);
  }
}
