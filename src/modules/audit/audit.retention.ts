import {
  PLATFORM_RETENTION_DAYS,
  type PlanId,
  planOf,
} from "@/modules/tenants";

/** The actor the retention job acts as (D16); it records no event per deletion. */
export const RETENTION_ACTOR = "system:audit:retention";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  /** Every tenant (trashed and purged included) with its current plan. */
  targets(): Promise<{ id: string; plan: PlanId }[]>;
  /** Removes the tenant's sign-in events recorded before `before`. */
  deleteAuthBefore(tenantId: string, before: Date): Promise<number>;
  /** Removes the console events about the tenant (`null`: the platform's own) recorded before `before`. */
  deleteAdminBefore(tenantId: string | null, before: Date): Promise<number>;
  log?: (message: string) => void;
}

export interface RetentionReport {
  /** Events removed, both logs together. */
  removed: number;
  /** How many tenants (or the platform) a pass could not finish; the next run takes them again. */
  failed: number;
}

const cutoff = (now: Date, days: number) =>
  new Date(now.getTime() - days * DAY_MS);

/**
 * The daily retention (D16): every tenant's sign-in log and console activity
 * is cut at its current plan's `auditRetentionDays` (so a plan change applies
 * at the next run), the platform's own events at 400 days. A purged tenant's
 * console events stay until their retention ends; its sign-in events went with
 * the purge. Each tenant is its own step: one that fails is logged and counted,
 * the others go on, and the next run takes it again. Deleting is idempotent.
 */
export async function enforceRetention(
  deps: RetentionDeps,
  now: Date = new Date(),
): Promise<RetentionReport> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const report: RetentionReport = { removed: 0, failed: 0 };
  const step = async (label: string, run: () => Promise<number>) => {
    try {
      report.removed += await run();
    } catch (error) {
      report.failed += 1;
      log(`audit: retention failed for ${label}: ${String(error)}`);
    }
  };
  for (const { id, plan } of await deps.targets()) {
    const before = cutoff(now, planOf(plan).auditRetentionDays);
    await step(`${id} (sign-ins)`, () => deps.deleteAuthBefore(id, before));
    await step(`${id} (activity)`, () => deps.deleteAdminBefore(id, before));
  }
  const platformBefore = cutoff(now, PLATFORM_RETENTION_DAYS);
  await step("the platform", () =>
    deps.deleteAdminBefore(null, platformBefore),
  );
  return report;
}
