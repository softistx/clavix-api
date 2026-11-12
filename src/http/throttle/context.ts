import type { Throttle } from "./core";

/**
 * The throttles of the anonymous operations (`requestSignInCode`,
 * `passkeySignInOptions`) as `createBase` puts them on every context;
 * `undefined`: no extra limit. A resolver reads `ctx.signInThrottle` typed,
 * with no cast.
 */
export interface ThrottleContext {
  readonly signInThrottle: Throttle | undefined;
  readonly passkeyThrottle: Throttle | undefined;
}
