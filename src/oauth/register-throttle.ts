import {
  type BoundLimits,
  createThrottle,
  ipAndTenantLimits,
  type LimitConfig,
  retryAfterSeconds,
  type Throttle,
} from "@/http/throttle/core";

export type RegisterLimitConfig = LimitConfig;
export type RegisterThrottle = Throttle;

/** `/register` past a limit: 429 with `Retry-After` (seconds). */
export class RegisterThrottledError extends Error {
  override name = "RegisterThrottledError";
  constructor(readonly retryAfter: number) {
    super("Too many registrations");
  }
}

// The two limits on `/register`, anonymous and storing a client per call
// (`ipAndTenantLimits`): per client address and tenant, and per tenant.
export const registerLimits = (config: RegisterLimitConfig) => {
  const { ip, tenant } = ipAndTenantLimits("register", config);
  return { registerIp: ip, registerTenant: tenant };
};

/**
 * The registration limits: the address first (a refused address spends no
 * tenant budget), then the tenant. Redis down or slow: the request goes
 * through, logged (the `agents` quota still bounds what is stored).
 */
export function createRegisterThrottle(
  limits: {
    registerIp: BoundLimits["ip"];
    registerTenant: BoundLimits["tenant"];
  },
  log?: (message: string) => void,
): RegisterThrottle {
  return createThrottle(
    { ip: limits.registerIp, tenant: limits.registerTenant },
    (result) => new RegisterThrottledError(retryAfterSeconds(result)),
    "register limits",
    log,
  );
}
