import { createSignInThrottle } from "@/modules/auth/throttle";
import { redis } from "./redis";

// The sign-in code limits on the app's Redis; none without REDIS_URL
// (development), where only janus's per-address limit applies.
export const signInThrottle =
  redis === undefined ? undefined : createSignInThrottle(redis.limits);
