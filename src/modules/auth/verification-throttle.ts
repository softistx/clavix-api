import {
  type BoundLimits,
  createUserThrottle,
  retryAfterSeconds,
  type UserBoundLimits,
  type UserLimitConfig,
  type UserThrottle,
  userAndTenantLimits,
} from "@/http/throttle/core";
import { fail } from "@/shared/errors";

export type VerificationLimitConfig = UserLimitConfig;
export type VerificationThrottle = UserThrottle;

// The three limits on `requestEmailVerification`, on top of janus's per-address
// one (5 per 10 min): per user (the signed-in account), per client address and
// tenant, and per tenant (`userAndTenantLimits`).
export const verificationLimits = (config: VerificationLimitConfig) => {
  const { ip, tenant, user } = userAndTenantLimits("verify", config);
  return { verifyIp: ip, verifyTenant: tenant, verifyUser: user };
};

/** `EMAIL_VERIFICATION_THROTTLED`, 429, `retryAfter` in the error and `Retry-After` (seconds). */
export const emailVerificationThrottled = (retryAfter: number) =>
  fail(
    "EMAIL_VERIFICATION_THROTTLED",
    "Too many verification e-mails requested",
    { status: 429, retryAfter },
  );

/**
 * The user first, then the address and the tenant. Redis down or slow: the
 * request goes through, logged; janus's per-address limit still holds.
 */
export function createVerificationThrottle(
  limits: {
    verifyUser: UserBoundLimits["user"];
    verifyIp: BoundLimits["ip"];
    verifyTenant: BoundLimits["tenant"];
  },
  log?: (message: string) => void,
): VerificationThrottle {
  return createUserThrottle(
    {
      user: limits.verifyUser,
      ip: limits.verifyIp,
      tenant: limits.verifyTenant,
    },
    (result) => emailVerificationThrottled(retryAfterSeconds(result)),
    "e-mail verification limits",
    log,
  );
}
