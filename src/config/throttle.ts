import { createSignInThrottle } from "@/modules/auth/auth.throttle";
import { createVerificationThrottle } from "@/modules/auth/auth.verification-throttle";
import { createDeviceThrottle } from "@/modules/consent/consent.device-throttle";
import { createPasskeyThrottle } from "@/modules/passkeys/passkeys.throttle";
import {
  createHomeRealmThrottle,
  createSsoStartThrottle,
} from "@/modules/sign-in-methods";
import {
  createMetadataThrottle,
  createRegisterThrottle,
} from "@/oauth/register-throttle";
import { redis } from "./redis";
import { warn } from "./runtime";

// The anonymous operations' limits on the app's Redis; none without REDIS_URL
// (development), where only janus's own limits apply.
export const signInThrottle =
  redis === undefined ? undefined : createSignInThrottle(redis.limits, warn);
export const passkeyThrottle =
  redis === undefined ? undefined : createPasskeyThrottle(redis.limits, warn);
export const homeRealmThrottle =
  redis === undefined ? undefined : createHomeRealmThrottle(redis.limits, warn);
export const ssoStartThrottle =
  redis === undefined ? undefined : createSsoStartThrottle(redis.limits, warn);
export const verifyThrottle =
  redis === undefined
    ? undefined
    : createVerificationThrottle(redis.limits, warn);
export const deviceThrottle =
  redis === undefined ? undefined : createDeviceThrottle(redis.limits, warn);
export const registerThrottle =
  redis === undefined ? undefined : createRegisterThrottle(redis.limits, warn);
export const metadataThrottle =
  redis === undefined ? undefined : createMetadataThrottle(redis.limits, warn);
