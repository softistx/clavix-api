import { createExclusive, type SharedLock } from "@/console/exclusive";
import { redis } from "./redis";

const shared = (): SharedLock | undefined => {
  if (redis === undefined) return undefined;
  const app = redis;
  return (key, work, options) => app.lock(key, work, options);
};

// One at a time per key, across the API's processes through the app's Redis
// (required in production); without it, within this process.
export const exclusive = createExclusive(shared());
