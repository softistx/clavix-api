import { MailThrottledError } from "@softistx/janus";
import { defineRateLimit, GuardError, type LimitResult } from "@softistx/redis";

export interface SignInLimitConfig {
  /** Requests one client address may make for one tenant, per `ipWindowSeconds`. */
  ipLimit: number;
  ipWindowSeconds: number;
  /** Requests a whole tenant may receive, per `tenantWindowSeconds`. */
  tenantLimit: number;
  tenantWindowSeconds: number;
}

// The limits come in pairs, per client address and tenant and per tenant,
// built by `ipAndTenantLimits` (also used by the passkeys' own pair).
// Both keys start with the tenant's id: a tenant's traffic never spends
// another's budget, and the same address on two tenants has two buckets.
// `burst` is the limit, so the bucket starts full and refills evenly over the
// window (GCRA, not a fixed window: see @softistx/redis "Rate limits").
// The result is handed to `defineRedis({ limits })`, which prefixes the names
// (`clavix:signin-ip:<tenantId>/<ip>`).
export const ipAndTenantLimits = (name: string, config: SignInLimitConfig) => ({
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

// The two limits on `requestSignInCode`, on top of janus's per-address one.
export const signInLimits = (config: SignInLimitConfig) => {
  const { ip, tenant } = ipAndTenantLimits("signin", config);
  return { signInIp: ip, signInTenant: tenant };
};

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

export interface SignInThrottle {
  /** Counts one request; past a limit it throws `MailThrottledError` (429, `Retry-After`). */
  check(who: { tenantId: string; ip: string | undefined }): Promise<void>;
}

// A slow Redis must not hold a request open.
const REDIS_TIMEOUT_MS = 250;
// A client whose address is unknown (no socket) shares one bucket.
export const UNKNOWN_IP = "unknown";

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
): SignInThrottle {
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
        const reason =
          error instanceof GuardError ? error.code : "connection failed";
        log(`redis unavailable: ${skipped} skipped (${reason})`);
      }
    },
  };
}

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
  log?: (message: string) => void,
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
