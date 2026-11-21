/** Runs `work` alone for its `key`: no other `work` of the same key runs beside it. */
export type Exclusive = <T>(key: string, work: () => Promise<T>) => Promise<T>;

/** A lock shared by every process (the app's Redis `lock`). */
export type SharedLock = <T>(
  key: string,
  work: () => Promise<T>,
  options: { ttl: number; wait: number },
) => Promise<T>;

// The work is a handful of store calls; a holder that takes longer than `ttl`
// is no longer protected and the lock reports it (`LOCK_LOST`).
const LOCK = { ttl: 10_000, wait: 5_000 } as const;

/**
 * `Exclusive` for this process (a queue per key), and across processes when a
 * shared lock is given. Without one (`null`: no Redis, outside production) a single
 * process is assumed. A shared lock that cannot be taken rejects: the work
 * does not run.
 */
export function createExclusive(shared: SharedLock | null): Exclusive {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = () =>
      shared === null ? work() : shared(`exclusive:${key}`, work, LOCK);
    const previous = tails.get(key) ?? Promise.resolve();
    const mine = previous.then(run, run);
    const tail = mine.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return mine;
  };
}
