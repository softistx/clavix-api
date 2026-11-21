import type { RotationDeps } from "./keys.service";
import { rotateAllTenants } from "./keys.service";

/** The queue surface the worker needs (`redis.queues.keyRotation`). */
export interface RotationQueue {
  work(handler: () => Promise<void>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/**
 * Runs a pass now (a tenant seeded by a migration gets its key without waiting
 * for the hour), then one per hourly tick when a queue is given. A pass with a
 * failed tenant throws so the queue retries it; at start a failure is logged.
 */
export async function startKeyRotation(
  deps: RotationDeps,
  queue?: RotationQueue,
) {
  const log = deps.log;
  const pass = async () => {
    const { failed } = await rotateAllTenants(deps);
    if (failed > 0)
      throw new Error(`keys: rotation failed for ${failed} tenant(s)`);
  };
  await pass().catch((error) => log(String(error)));
  queue?.work(pass).on("error", (error) => log(`keys: ${String(error)}`));
}
