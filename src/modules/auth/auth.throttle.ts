import { MailThrottledError } from "@softistx/janus";
import {
  type BoundLimits,
  createThrottle,
  ipAndTenantLimits,
  type LimitConfig,
  retryAfterSeconds,
  type Throttle,
} from "@/http/throttle/core";

export type SignInLimitConfig = LimitConfig;
export type SignInThrottle = Throttle;

// The two limits on `requestSignInCode`, on top of janus's per-address one.
export const signInLimits = (config: SignInLimitConfig) => {
  const { ip, tenant } = ipAndTenantLimits("signin", config);
  return { signInIp: ip, signInTenant: tenant };
};

/**
 * The sign-in code limits. The same `MAIL_THROTTLED` as the per-address limit
 * (janus's error, so the same answer and `Retry-After`). Redis down: the
 * request goes through (logged), janus's per-address limit still holds.
 */
export function createSignInThrottle(
  limits: {
    signInIp: BoundLimits["ip"];
    signInTenant: BoundLimits["tenant"];
  },
  log: (message: string) => void,
): SignInThrottle {
  return createThrottle(
    { ip: limits.signInIp, tenant: limits.signInTenant },
    (result) =>
      new MailThrottledError("Too many sign-in codes requested", {
        retryAfter: retryAfterSeconds(result),
      }),
    "sign-in code limits",
    log,
  );
}
