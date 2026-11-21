import {
  ConflictError,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { Tenant } from "@/modules/tenants";
import { effectiveQuotas, type QuotaKey, type Quotas } from "@/modules/tenants";
import type { usageCounters } from "./usage.model";
import type { MauCounter, UsageReport, UsageSources } from "./usage.types";
import { messageOf, meter, monthOf } from "./usage.utils";

/**
 * A tenant's use against its quotas. Active users are counted when a session
 * opens or a token is refreshed; `clients` and `domains` are read now.
 */
export class UsageService {
  constructor(
    private readonly snapshots: TypedCollection<typeof usageCounters>,
    private readonly sources: UsageSources,
    /** `undefined` without Redis: nothing is counted, the last stored month is read. */
    private readonly mau: MauCounter | undefined,
    private readonly log: (message: string) => void,
    private readonly now: () => Date,
  ) {}

  /**
   * Counts a user as active this month. Never throws: a counter that cannot
   * be written (Redis down) must not fail a sign-in or a refresh.
   */
  async recordActive(tenantId: string, userId: string): Promise<void> {
    if (this.mau === undefined || userId === "") return;
    try {
      await this.mau.add({ tenantId, month: monthOf(this.now()) }, userId);
    } catch (error) {
      this.log(
        `usage: could not count an active user of ${tenantId}: ${messageOf(error)}`,
      );
    }
  }

  /** The quotas that apply to the tenant. */
  quotasOf(tenant: Pick<Tenant, "plan" | "quotaOverrides">): Quotas {
    return effectiveQuotas(tenant);
  }

  /** The tenant's meters for `month` (default: this month). */
  async report(
    tenant: Pick<Tenant, "_id" | "plan" | "quotaOverrides">,
    month: string = monthOf(this.now()),
  ): Promise<UsageReport> {
    const tenantId = tenant._id.toHexString();
    const quotas = effectiveQuotas(tenant);
    const [mau, clients, domains, agents, webhooks, connections] =
      await Promise.all([
        this.activeUsers(tenantId, month),
        this.sources.clients(tenantId),
        this.sources.domains(tenantId),
        this.sources.agents(tenantId),
        this.sources.webhooks(tenantId),
        this.sources.connections(tenantId),
      ]);
    return {
      tenantId,
      month,
      mau: meter(mau, quotas.mau),
      clients: meter(clients, quotas.clients),
      domains: meter(domains, quotas.domains),
      agents: meter(agents, quotas.agents),
      webhooks: meter(webhooks, quotas.webhooks),
      connections: meter(connections, quotas.connections),
    };
  }

  /** The count of `key` now, for the hard quotas (`clients`, `domains`, `agents`, `webhooks`, `connections`). */
  count(tenantId: string, key: Exclude<QuotaKey, "mau">): Promise<number> {
    return this.sources[key](tenantId);
  }

  // The counted value, stored when larger than what is stored; without Redis
  // or when it fails, the stored one (0 for a month never read).
  private async activeUsers(tenantId: string, month: string): Promise<number> {
    const scoped = scopeToTenant(this.snapshots, new ObjectId(tenantId));
    const stored = await scoped.findFirst({ month });
    let counted: number | undefined;
    if (this.mau !== undefined) {
      try {
        counted = await this.mau.count({ tenantId, month });
      } catch (error) {
        this.log(
          `usage: could not read the active users of ${tenantId}: ${messageOf(error)}`,
        );
      }
    }
    if (counted === undefined || counted === 0) return stored?.mau ?? 0;
    if (stored === undefined) {
      try {
        await scoped.create({ month, mau: counted });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
    } else if (counted > stored.mau) {
      await scoped.update(stored._id, { mau: counted });
    }
    return Math.max(counted, stored?.mau ?? 0);
  }
}
