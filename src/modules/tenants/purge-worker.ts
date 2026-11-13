import type { PurgeReport } from "./purge";

/** The queue surface the worker needs (`redis.queues.tenantPurge`). */
export interface PurgeQueue {
  work(handler: () => Promise<void>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/**
 * Runs a pass now (a restart finishes a purge left claimed), then one per daily
 * tick when a queue is given. A pass with a failed tenant throws so the queue
 * retries it; at start a failure is logged. Only tenants whose 30 days of
 * trash are over are touched (`purgeTenants`).
 */
export async function startTenantPurge(
  run: () => Promise<PurgeReport>,
  queue?: PurgeQueue,
  log: (message: string) => void = (m) => console.warn(m),
) {
  const pass = async () => {
    const { failed } = await run();
    if (failed.length > 0)
      throw new Error(`tenants: purge failed for ${failed.length} tenant(s)`);
  };
  await pass().catch((error) => log(String(error)));
  queue?.work(pass).on("error", (error) => log(`tenants: ${String(error)}`));
}
