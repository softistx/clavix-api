import type { PruneReport } from "./prune";

/** The queue surface the worker needs (`redis.queues.agentsPrune`). */
export interface PruneQueue {
  work(handler: () => Promise<void>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/**
 * Runs the clean-up on each daily tick of the queue. Without a queue
 * (development, no Redis) nothing runs: there is no pass at start, since
 * nothing is urgent. A pass that left an agent unfinished throws, so the queue
 * retries it.
 */
export function startAgentsPrune(
  run: () => Promise<PruneReport>,
  queue?: PruneQueue,
  log: (message: string) => void = (m) => console.warn(m),
) {
  queue
    ?.work(async () => {
      const { failed } = await run();
      if (failed > 0) {
        throw new Error(`agents: prune left ${failed} agent(s) unfinished`);
      }
    })
    .on("error", (error) => log(`agents: ${String(error)}`));
}
