import { GraphQLError } from "graphql";
import {
  type BoundLimits,
  createThrottle,
  ipAndTenantLimits,
  type LimitConfig,
  retryAfterSeconds,
  type Throttle,
} from "@/http/throttle/core";

export type PasskeyLimitConfig = LimitConfig;
export type PasskeyThrottle = Throttle;

// The two limits on the anonymous `passkeySignInOptions`, which writes one
// token per call: per client address and tenant, and per tenant. Same shape
// and keys as the sign-in code ones (`ipAndTenantLimits`), their own buckets.
export const passkeyLimits = (config: PasskeyLimitConfig) => {
  const { ip, tenant } = ipAndTenantLimits("passkey", config);
  return { passkeyIp: ip, passkeyTenant: tenant };
};

/** `PASSKEY_THROTTLED`, 429 with `Retry-After` (seconds). */
export const passkeyThrottled = (retryAfter: number) =>
  new GraphQLError("Too many passkey sign-ins requested", {
    extensions: {
      code: "PASSKEY_THROTTLED",
      http: { status: 429, headers: { "retry-after": String(retryAfter) } },
    },
  });

/** Address first, then tenant; Redis down: the request goes through, logged. */
export const createPasskeyThrottle = (
  limits: {
    passkeyIp: BoundLimits["ip"];
    passkeyTenant: BoundLimits["tenant"];
  },
  log?: (message: string) => void,
): PasskeyThrottle =>
  createThrottle(
    { ip: limits.passkeyIp, tenant: limits.passkeyTenant },
    (result) => passkeyThrottled(retryAfterSeconds(result)),
    "passkey sign-in limits",
    log,
  );
