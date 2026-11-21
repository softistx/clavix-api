import { MailThrottledError } from "@softistx/janus";
import {
  type BoundLimits,
  createThrottle,
  ipAndTenantLimits,
  type LimitConfig,
  retryAfterSeconds,
  type Throttle,
} from "@/http/throttle/core";

export type SsoLimitConfig = LimitConfig;
export type SsoThrottle = Throttle;

// The anonymous sign-in starts that send no mail: `hostedHomeRealm` (which
// connection owns an address) and `socialSignInStart` (a social provider or an
// enterprise connection). Each has its own pair of buckets, per client address
// and tenant and per tenant, under one configuration: neither spends the
// sign-in code budget, whose tenant-wide cap is sized for mail, and a flood of
// one does not close the other.
export const ssoLimits = (config: SsoLimitConfig) => {
  const home = ipAndTenantLimits("home-realm", config);
  const start = ipAndTenantLimits("sso-start", config);
  return {
    homeRealmIp: home.ip,
    homeRealmTenant: home.tenant,
    ssoStartIp: start.ip,
    ssoStartTenant: start.tenant,
  };
};

// The same `MAIL_THROTTLED` (429, `Retry-After`) these operations answered
// when they spent the sign-in code budget: the hosted pages already read it.
const refused = (result: Parameters<typeof retryAfterSeconds>[0]) =>
  new MailThrottledError("Too many sign-in attempts", {
    retryAfter: retryAfterSeconds(result),
  });

/** `hostedHomeRealm`: address first, then tenant; Redis down: the request goes through, logged. */
export const createHomeRealmThrottle = (
  limits: {
    homeRealmIp: BoundLimits["ip"];
    homeRealmTenant: BoundLimits["tenant"];
  },
  log: (message: string) => void,
): SsoThrottle =>
  createThrottle(
    { ip: limits.homeRealmIp, tenant: limits.homeRealmTenant },
    refused,
    "home-realm limits",
    log,
  );

/** `socialSignInStart`: address first, then tenant; Redis down: the request goes through, logged. */
export const createSsoStartThrottle = (
  limits: {
    ssoStartIp: BoundLimits["ip"];
    ssoStartTenant: BoundLimits["tenant"];
  },
  log: (message: string) => void,
): SsoThrottle =>
  createThrottle(
    { ip: limits.ssoStartIp, tenant: limits.ssoStartTenant },
    refused,
    "single sign-on start limits",
    log,
  );
