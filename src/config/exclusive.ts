import { RedisError } from "@softistx/redis";
import { GraphQLError } from "graphql";
import { createExclusive, type SharedLock } from "@/console/exclusive";
import { redis } from "./redis";

/** The shared lock over an app Redis: a lock that cannot be taken is a retryable 503. */
export const sharedLockOf = (app: {
  lock: <T>(
    key: string,
    work: () => Promise<T>,
    options: { ttl: number; wait: number },
  ) => Promise<T>;
}): SharedLock => {
  // The lock held too long by another, or Redis down: the work did not run
  // (or ran past its deadline); the caller may ask again.
  return (key, work, options) =>
    app.lock(key, work, options).catch((error: unknown) => {
      if (!(error instanceof RedisError)) throw error;
      throw new GraphQLError("Try again later", {
        extensions: { code: "SERVICE_UNAVAILABLE", http: { status: 503 } },
      });
    });
};

// One at a time per key, across the API's processes through the app's Redis
// (required in production); without it, within this process.
export const exclusive = createExclusive(
  redis === undefined ? undefined : sharedLockOf(redis),
);
