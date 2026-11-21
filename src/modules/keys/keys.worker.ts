import type { KeysService } from "./keys.service";

/** The queue surface the worker needs (`redis.queues.keyRotation`). */
export interface RotationQueue {
  work(handler: () => Promise<void>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/** What the worker runs over: the service, the active tenants, the log. */
export interface RotationJob {
  keys: Pick<KeysService, "rotateAll">;
  /** The ids (hex) of the tenants that sign: the active ones. */
  activeTenantIds: () => Promise<string[]>;
  log: (message: string) => void;
}

/**
 * Runs a pass now (a tenant seeded by a migration gets its key without waiting
 * for the hour), then one per hourly tick when a queue is given. A pass with a
 * failed tenant throws so the queue retries it; at start a failure is logged.
 */
export async function startKeyRotation(
  { keys, activeTenantIds, log }: RotationJob,
  queue: RotationQueue,
) {
  const pass = async () => {
    const { failed } = await keys.rotateAll(await activeTenantIds());
    if (failed > 0)
      throw new Error(`keys: rotation failed for ${failed} tenant(s)`);
  };
  await pass().catch((error) => log(String(error)));
  queue.work(pass).on("error", (error) => log(`keys: ${String(error)}`));
}
