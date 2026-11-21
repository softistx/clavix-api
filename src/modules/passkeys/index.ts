// The module's import surface (passkeys: sign-in and management). The resolver
// is not here: `modules/index.ts` imports it by file, so this barrel never
// loads the config wiring back. `passkeys.throttle` is also imported by file
// by config/redis.ts and config/throttle.ts, and `passkeys.errors` by
// i18n/codes.ts (AGENTS.md "Layout (A10)").

export {
  asPasskeyInvalid,
  passkeyInvalid,
  passkeyThrottled,
} from "./passkeys.errors";
export { PasskeysService } from "./passkeys.service";
export {
  createPasskeyThrottle,
  type PasskeyLimitConfig,
  type PasskeyThrottle,
  passkeyLimits,
} from "./passkeys.throttle";
export type { PasskeysPorts } from "./passkeys.types";
export { currentOf, responseOf } from "./passkeys.utils";
