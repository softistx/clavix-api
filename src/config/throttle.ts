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
import { noThrottle, noUserThrottle } from "./no-ops";
import { redis } from "./redis";
import { warn } from "./runtime";

// The anonymous operations' limits on the app's Redis; the named no-op without
// REDIS_URL (development), where only janus's own limits apply.
export const signInThrottle =
  redis === undefined ? noThrottle : createSignInThrottle(redis.limits, warn);
export const passkeyThrottle =
  redis === undefined ? noThrottle : createPasskeyThrottle(redis.limits, warn);
export const homeRealmThrottle =
  redis === undefined
    ? noThrottle
    : createHomeRealmThrottle(redis.limits, warn);
export const ssoStartThrottle =
  redis === undefined ? noThrottle : createSsoStartThrottle(redis.limits, warn);
export const verifyThrottle =
  redis === undefined
    ? noUserThrottle
    : createVerificationThrottle(redis.limits, warn);
export const deviceThrottle =
  redis === undefined
    ? noUserThrottle
    : createDeviceThrottle(redis.limits, warn);
export const registerThrottle =
  redis === undefined ? noThrottle : createRegisterThrottle(redis.limits, warn);
export const metadataThrottle =
  redis === undefined ? noThrottle : createMetadataThrottle(redis.limits, warn);
