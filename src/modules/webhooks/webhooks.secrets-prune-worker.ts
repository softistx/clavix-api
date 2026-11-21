import type { SecretsPruneReport } from "./webhooks.secrets-prune";

/** The queue surface the worker needs (`redis.queues.webhookSecretsPrune`). */
export interface SecretsPruneQueue {
  work(handler: () => Promise<void>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/**
 * Runs the clean-up on each daily tick of the queue. The server starts it
 * only with a queue (development, no Redis: no worker): an expired secret is ignored at send
 * time anyway. A pass that left a tenant unfinished throws, so the queue
 * retries it.
 */
export function startWebhookSecretsPrune(
  run: () => Promise<SecretsPruneReport>,
  queue: SecretsPruneQueue,
  log: (message: string) => void,
) {
  queue
    .work(async () => {
      const { failed } = await run();
      if (failed > 0) {
        throw new Error(
          `webhooks: secrets prune left ${failed} tenant(s) unfinished`,
        );
      }
    })
    .on("error", (error) => log(`webhooks: ${String(error)}`));
}
