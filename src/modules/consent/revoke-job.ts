import type { Context } from "@/http/context";
import { revokeOAuthGrants } from "./revoke";

/** What a queued revocation carries: ids only. */
export interface RevokeJob {
  tenantId: string;
  userId: string;
}

/** The queue surface the sign-in needs (`redis.queues.grantsRevoke`). */
export interface RevokeEnqueuer {
  add(data: RevokeJob): Promise<unknown>;
}

/** The queue surface the worker needs. */
export interface RevokeWorkerQueue {
  work(handler: (job: { data: RevokeJob }) => Promise<unknown>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/**
 * Revokes the replaced holder's grants now; when that fails, the revocation is
 * put on the retryable queue and the sign-in goes on once the job is stored.
 * With no queue, or when the queue cannot be written, the original failure
 * propagates and the sign-in fails (janus does not repeat `replaced`, so a
 * retried sign-in would not revoke).
 */
export async function revokeOnReplace(
  ctx: Context,
  tenantId: string,
  userId: string,
  queue: RevokeEnqueuer | undefined,
  revoke: (ctx: Context, userId: string) => Promise<number> = revokeOAuthGrants,
  log: (message: string) => void = (m) => console.warn(m),
): Promise<void> {
  try {
    await revoke(ctx, userId);
  } catch (error) {
    if (queue === undefined) throw error;
    try {
      await queue.add({ tenantId, userId });
    } catch (queueError) {
      log(`grants: revocation not queued: ${String(queueError)}`);
      throw error;
    }
    log(`grants: revocation queued after a failure: ${String(error)}`);
  }
}

/**
 * Runs each queued revocation; a failure throws so the queue retries it with
 * backoff. Without a queue (development, no Redis) nothing runs.
 */
export function startGrantsRevoke(
  run: (job: RevokeJob) => Promise<number>,
  queue?: RevokeWorkerQueue,
  log: (message: string) => void = (m) => console.warn(m),
) {
  queue
    ?.work(async ({ data }) => {
      await run(data);
    })
    .on("error", (error) => log(`grants: ${String(error)}`));
}
