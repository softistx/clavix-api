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

// The two limits on `requestSignInCode`, on top of janus's per-address one.
// Both keys start with the tenant's id: a tenant's traffic never spends
// another's budget, and the same address on two tenants has two buckets.
// `burst` is the limit, so the bucket starts full and refills evenly over the
// window (GCRA, not a fixed window: see @softistx/redis "Rate limits").
// `signInLimits(env)` is handed to `defineRedis({ limits })`, which prefixes
// the names (`clavix:signin-ip:<tenantId>/<ip>`).
export const signInLimits = (config: SignInLimitConfig) => ({
  signInIp: defineRateLimit({
    name: "signin-ip",
    key: (who: { tenantId: string; ip: string }) => `${who.tenantId}/${who.ip}`,
    limit: config.ipLimit,
    per: config.ipWindowSeconds * 1000,
  }),
  signInTenant: defineRateLimit({
    name: "signin-tenant",
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

export interface SignInThrottle {
  /** Counts one request; past a limit it throws `MailThrottledError` (429, `Retry-After`). */
  check(who: { tenantId: string; ip: string | undefined }): Promise<void>;
}

// A slow Redis must not hold a sign-in open.
const REDIS_TIMEOUT_MS = 250;
// A client whose address is unknown (no socket) shares one bucket.
export const UNKNOWN_IP = "unknown";

/**
 * The address is counted first: a denied address does not spend the tenant's
 * budget. The same `MAIL_THROTTLED` as the per-address limit (janus's error,
 * so the same answer and `Retry-After`). Redis down: the request goes through
 * (logged), janus's per-address limit still holds.
 */
export function createSignInThrottle(
  limits: {
    signInIp: Bound<{ tenantId: string; ip: string }>;
    signInTenant: Bound<{ tenantId: string }>;
  },
  log: (message: string) => void = (message) => console.warn(message),
): SignInThrottle {
  const options = { timeoutMs: REDIS_TIMEOUT_MS };
  const refuse = (result: LimitResult) =>
    new MailThrottledError("Too many sign-in codes requested", {
      retryAfter: Math.max(1, Math.ceil(result.retryAfter / 1000)),
    });
  return {
    async check({ tenantId, ip }) {
      try {
        const byIp = await limits.signInIp.consume(
          { tenantId, ip: ip ?? UNKNOWN_IP },
          1,
          options,
        );
        if (!byIp.allowed) throw refuse(byIp);
        const byTenant = await limits.signInTenant.consume(
          { tenantId },
          1,
          options,
        );
        if (!byTenant.allowed) throw refuse(byTenant);
      } catch (error) {
        if (error instanceof MailThrottledError) throw error;
        // A GuardError (timeout) or the client's own (connection closed).
        const reason =
          error instanceof GuardError ? error.code : "connection failed";
        log(`redis unavailable: sign-in code limits skipped (${reason})`);
      }
    },
  };
}
