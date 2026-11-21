import {
  deviceThrottle,
  homeRealmThrottle,
  passkeyThrottle,
  signInThrottle,
  ssoStartThrottle,
  verifyThrottle,
} from "@/config/throttle";
import type { ThrottleContext } from "@/http/throttle/context";

/**
 * The limits `createApp` hands the base: an option present in `options` wins,
 * even as `undefined` (a spec turns a limit off that way); the app's own
 * (`config/throttle.ts`) otherwise.
 */
export const throttlesFor = (
  options: Partial<ThrottleContext>,
): ThrottleContext => ({
  signInThrottle:
    "signInThrottle" in options ? options.signInThrottle : signInThrottle,
  passkeyThrottle:
    "passkeyThrottle" in options ? options.passkeyThrottle : passkeyThrottle,
  homeRealmThrottle:
    "homeRealmThrottle" in options
      ? options.homeRealmThrottle
      : homeRealmThrottle,
  ssoStartThrottle:
    "ssoStartThrottle" in options ? options.ssoStartThrottle : ssoStartThrottle,
  verifyThrottle:
    "verifyThrottle" in options ? options.verifyThrottle : verifyThrottle,
  deviceThrottle:
    "deviceThrottle" in options ? options.deviceThrottle : deviceThrottle,
});
