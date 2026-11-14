import type { VerificationThrottle } from "@/modules/auth/verification-throttle";
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
  /** The signed-in `requestEmailVerification`: per user, client address and tenant. */
  readonly verifyThrottle: VerificationThrottle | undefined;
}
