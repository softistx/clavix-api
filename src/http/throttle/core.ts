import { defineRateLimit, GuardError, type LimitResult } from "@softistx/redis";

export interface LimitConfig {
  /** Requests one client address may make for one tenant, per `ipWindowSeconds`. */
  ipLimit: number;
  ipWindowSeconds: number;
  /** Requests a whole tenant may receive, per `tenantWindowSeconds`. */
  tenantLimit: number;
  tenantWindowSeconds: number;
}

// The limits come in pairs, per client address and tenant and per tenant,
// built by `ipAndTenantLimits` (the sign-in code's and the passkeys' pairs).
// Both keys start with the tenant's id: a tenant's traffic never spends
// another's budget, and the same address on two tenants has two buckets.
// `burst` is the limit, so the bucket starts full and refills evenly over the
// window (GCRA, not a fixed window: see @softistx/redis "Rate limits").
// The result is handed to `defineRedis({ limits })`, which prefixes the names
// (`clavix:signin-ip:<tenantId>/<ip>`).
export const ipAndTenantLimits = (name: string, config: LimitConfig) => ({
  ip: defineRateLimit({
    name: `${name}-ip`,
    key: (who: { tenantId: string; ip: string }) => `${who.tenantId}/${who.ip}`,
    limit: config.ipLimit,
    per: config.ipWindowSeconds * 1000,
  }),
  tenant: defineRateLimit({
    name: `${name}-tenant`,
    key: (who: { tenantId: string }) => who.tenantId,
    limit: config.tenantLimit,
    per: config.tenantWindowSeconds * 1000,
  }),
});

interface Bound<P> {
  consume(
    params: P,
    cost?: number,
    options?: { timeoutMs: number },
  ): Promise<LimitResult>;
}

export interface BoundLimits {
  ip: Bound<{ tenantId: string; ip: string }>;
  tenant: Bound<{ tenantId: string }>;
}

export interface Throttle {
  /** Counts one request; past a limit it throws what the throttle was built to refuse with. */
  check(who: { tenantId: string; ip: string | undefined }): Promise<void>;
}

// A slow Redis must not hold a request open.
export const REDIS_TIMEOUT_MS = 250;
// A client whose address is unknown (no socket) shares one bucket.
export const UNKNOWN_IP = "unknown";

/** Logs that a limit was skipped because Redis is down or slow; the request goes through. */
export function logSkipped(
  error: unknown,
  skipped: string,
  log: (message: string) => void,
) {
  const reason = error instanceof GuardError ? error.code : "connection failed";
  log(`redis unavailable: ${skipped} skipped (${reason})`);
}

/**
 * Counts one request on a single limit of its own (the signed-in operations
 * add one beside the pair): `undefined` when Redis is down, logged.
 */
export async function consumeOrSkip<P>(
  limit: Bound<P>,
  params: P,
  skipped: string,
  log: (message: string) => void,
): Promise<LimitResult | undefined> {
  try {
    return await limit.consume(params, 1, { timeoutMs: REDIS_TIMEOUT_MS });
  } catch (error) {
    logSkipped(error, skipped, log);
    return undefined;
  }
}

/** Whole seconds a refused client waits, at least 1. */
export const retryAfterSeconds = (result: LimitResult) =>
  Math.max(1, Math.ceil(result.retryAfter / 1000));

/**
 * The shared check of the anonymous operations: the address is counted first
 * (a denied address does not spend the tenant's budget), then the tenant.
 * Past a limit it throws what `refuse` builds; Redis down (a `GuardError`
 * timeout or the client's own): the request goes through, logged with
 * `skipped`. Only the errors `refuse` built pass; the rest are Redis's.
 */
export function createThrottle(
  limits: BoundLimits,
  refuse: (result: LimitResult) => Error,
  skipped: string,
  log: (message: string) => void = (message) => console.warn(message),
): Throttle {
  const options = { timeoutMs: REDIS_TIMEOUT_MS };
  const refusals = new WeakSet<Error>();
  const deny = (result: LimitResult) => {
    const error = refuse(result);
    refusals.add(error);
    return error;
  };
  return {
    async check({ tenantId, ip }) {
      try {
        const byIp = await limits.ip.consume(
          { tenantId, ip: ip ?? UNKNOWN_IP },
          1,
          options,
        );
        if (!byIp.allowed) throw deny(byIp);
        const byTenant = await limits.tenant.consume({ tenantId }, 1, options);
        if (!byTenant.allowed) throw deny(byTenant);
      } catch (error) {
        if (error instanceof Error && refusals.has(error)) throw error;
        logSkipped(error, skipped, log);
      }
    },
  };
}

/** The throttle of a signed-in operation: the user is counted too. */
export interface UserThrottle {
  check(who: {
    tenantId: string;
    userId: string;
    ip: string | undefined;
  }): Promise<void>;
}
