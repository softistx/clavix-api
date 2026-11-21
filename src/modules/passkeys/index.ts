// The module's import surface (passkeys: sign-in and management). Imported by
// file: `passkeys.resolver` (`modules/index.ts`), `passkeys.throttle`
// (`config/redis.ts`, `config/redis-limits.ts`) and `passkeys.errors`
// (`i18n/codes.ts`), so this barrel never loads the config wiring.

export { asPasskeyInvalid, passkeyThrottled } from "./passkeys.errors";
export { PasskeysService } from "./passkeys.service";
export { createPasskeyThrottle } from "./passkeys.throttle";
export { currentOf, responseOf } from "./passkeys.utils";
