import type { RetentionReport } from "./audit.retention";

/** The queue surface the worker needs (`redis.queues.auditRetention`). */
export interface RetentionQueue {
  work(handler: () => Promise<void>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/**
 * Runs the retention on each daily tick of the queue. The server starts it
 * only with a queue (development, no Redis: no worker). A pass that left a tenant unfinished
 * throws, so the queue retries it.
 */
export function startAuditRetention(
  run: () => Promise<RetentionReport>,
  queue: RetentionQueue,
  log: (message: string) => void,
) {
  queue
    .work(async () => {
      const { failed } = await run();
      if (failed > 0) {
        throw new Error(`audit: retention left ${failed} step(s) unfinished`);
      }
    })
    .on("error", (error) => log(`audit: ${String(error)}`));
}
