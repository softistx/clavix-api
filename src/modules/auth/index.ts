// The module's import surface (the hosted sign-in: e-mail code, magic link,
// e-mail verification, sign-out). Imported by file: `auth.resolver`
// (`modules/index.ts`), `auth.plugin` (`http/graphql-mount.ts`, `http/schema.ts`),
// `auth.throttle` and `auth.verification-throttle` (`config/redis.ts`,
// `config/redis-limits.ts`) and `auth.errors` (`i18n/codes.ts`), each loading
// the config wiring or closing a cycle through this barrel.

export {
  REPLACED_REASON,
  reasonOf,
  recordingSignIn,
  sourceOf,
} from "./auth.events";
export { drain, settled } from "./auth.outbox";
export { AuthService } from "./auth.service";
export { createSignInThrottle, signInLimits } from "./auth.throttle";
export { createVerificationThrottle } from "./auth.verification-throttle";
