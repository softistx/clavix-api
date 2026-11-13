import { RedisError } from "@softistx/redis";
import { GraphQLError } from "graphql";
import { createExclusive, type SharedLock } from "@/console/exclusive";
import { redis } from "./redis";

const shared = (): SharedLock | undefined => {
  if (redis === undefined) return undefined;
  const app = redis;
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
export const exclusive = createExclusive(shared());
