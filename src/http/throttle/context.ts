import type { Throttle, UserThrottle } from "./core";

/**
 * The throttles of the anonymous operations (`requestSignInCode`,
 * `passkeySignInOptions`, `hostedHomeRealm`, `socialSignInStart`) as `createBase` puts them on every context;
 * `noThrottle` / `noUserThrottle` (config/no-ops.ts): no extra limit. A resolver reads `ctx.signInThrottle` typed,
 * with no cast.
 */
export interface ThrottleContext {
  readonly signInThrottle: Throttle;
  readonly passkeyThrottle: Throttle;
  /** The anonymous `hostedHomeRealm`: its own budget, apart from the mail-sending sign-in one. */
  readonly homeRealmThrottle: Throttle;
  /** The anonymous `socialSignInStart` (social and enterprise): its own budget too. */
  readonly ssoStartThrottle: Throttle;
  /** The signed-in `requestEmailVerification`: per user, client address and tenant. */
  readonly verifyThrottle: UserThrottle;
  /** The signed-in device verification lookups: per user, client address and tenant. */
  readonly deviceThrottle: UserThrottle;
}

/** The six throttles of a set of options, as `createBase` decorates them onto the context. */
export const throttlesOf = (options: ThrottleContext): ThrottleContext => ({
  signInThrottle: options.signInThrottle,
  passkeyThrottle: options.passkeyThrottle,
  homeRealmThrottle: options.homeRealmThrottle,
  ssoStartThrottle: options.ssoStartThrottle,
  verifyThrottle: options.verifyThrottle,
  deviceThrottle: options.deviceThrottle,
});
