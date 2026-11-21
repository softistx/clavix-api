// The module's import surface (the hosted sign-in: e-mail code, magic link,
// e-mail verification, sign-out). The resolver is not here: `modules/index.ts`
// imports it by file, so this barrel never loads the config wiring back. A few
// leaves are imported by file where the barrel would pull the wiring in
// (AGENTS.md "Layout (A10)"): `auth.throttle` and `auth.verification-throttle`
// (config/redis.ts, config/throttle.ts, app.ts), `auth.plugin` (app.ts,
// http/schema.ts) and `auth.errors` (i18n/codes.ts).

export {
  REPLACED_REASON,
  reasonOf,
  recordingSignIn,
  recordSignIn,
  recordSignOut,
  sourceOf,
} from "./auth.events";
export { afterAnswer, drain, settled } from "./auth.outbox";
export { AuthService } from "./auth.service";
export {
  createSignInThrottle,
  type SignInLimitConfig,
  type SignInThrottle,
  signInLimits,
} from "./auth.throttle";
export type { AuthPorts, SignInDone } from "./auth.types";
