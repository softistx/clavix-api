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
  log: (message: string) => void,
): RegisterThrottle {
  return createThrottle(
    { ip: limits.registerIp, tenant: limits.registerTenant },
    (result) => new RegisterThrottledError(retryAfterSeconds(result)),
    "register limits",
    log,
  );
}

export type MetadataLimitConfig = LimitConfig;
export type MetadataThrottle = Throttle;

/** A metadata document fetch past a limit: 429 with `Retry-After` (seconds). */
export class MetadataThrottledError extends Error {
  override name = "MetadataThrottledError";
  constructor(readonly retryAfter: number) {
    super("Too many client metadata document fetches");
  }
}

// `/authorize` and `/par` with a URL `client_id` make the server fetch that
// URL (3 s, 5 KB at most): an outbound request an anonymous caller chose.
export const metadataLimits = (config: MetadataLimitConfig) => {
  const { ip, tenant } = ipAndTenantLimits("metadata", config);
  return { metadataIp: ip, metadataTenant: tenant };
};

/** The address first, then the tenant; Redis down or slow: the request goes through, logged. */
export function createMetadataThrottle(
  limits: {
    metadataIp: BoundLimits["ip"];
    metadataTenant: BoundLimits["tenant"];
  },
  log: (message: string) => void,
): MetadataThrottle {
  return createThrottle(
    { ip: limits.metadataIp, tenant: limits.metadataTenant },
    (result) => new MetadataThrottledError(retryAfterSeconds(result)),
    "metadata fetch limits",
    log,
  );
}
