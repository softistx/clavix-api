import { createSignInThrottle } from "@/modules/auth/throttle";
import { createVerificationThrottle } from "@/modules/auth/verification-throttle";
import { createDeviceThrottle } from "@/modules/consent/device-throttle";
import { createPasskeyThrottle } from "@/modules/passkeys/throttle";
import { redis } from "./redis";

// The anonymous operations' limits on the app's Redis; none without REDIS_URL
// (development), where only janus's own limits apply.
export const signInThrottle =
  redis === undefined ? undefined : createSignInThrottle(redis.limits);
export const passkeyThrottle =
  redis === undefined ? undefined : createPasskeyThrottle(redis.limits);
export const verifyThrottle =
  redis === undefined ? undefined : createVerificationThrottle(redis.limits);
export const deviceThrottle =
  redis === undefined ? undefined : createDeviceThrottle(redis.limits);
