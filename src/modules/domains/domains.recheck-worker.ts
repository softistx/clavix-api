import type { DomainDoc } from "./domains.service";

/** The queue surface the worker needs (`redis.queues.domainRecheck`). */
export interface RecheckQueue {
  work(handler: () => Promise<void>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

export interface RecheckDeps {
  recheckAll(
    onUnverified: (domain: DomainDoc) => Promise<void>,
  ): Promise<{ checked: number; unverified: number }>;
  /** Tells the tenant's owners their domain lapsed. */
  notify(domain: DomainDoc): Promise<void>;
  log: (message: string) => void;
}

/**
 * Runs the TXT recheck on each tick of the queue (every 6 hours). Without a
 * queue (development, no Redis) nothing runs: there is no pass at start, since
 * a recheck is slow and not needed to serve.
 */
export function startDomainRecheck(deps: RecheckDeps, queue?: RecheckQueue) {
  const log = deps.log;
  queue
    ?.work(async () => {
      await deps.recheckAll(deps.notify);
    })
    .on("error", (error) => log(`domains: ${String(error)}`));
}
