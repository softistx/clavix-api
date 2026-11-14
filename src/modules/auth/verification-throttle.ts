import { defineRateLimit, GuardError, type LimitResult } from "@softistx/redis";
import { GraphQLError } from "graphql";
import {
  type BoundLimits,
  createThrottle,
  ipAndTenantLimits,
  type LimitConfig,
  retryAfterSeconds,
} from "@/http/throttle/core";

export interface VerificationLimitConfig extends LimitConfig {
  /** Verification mails one signed-in user may ask for, per `userWindowSeconds`. */
  userLimit: number;
  userWindowSeconds: number;
}

export interface VerificationThrottle {
  /** Counts one `requestEmailVerification`; past a limit it throws `EMAIL_VERIFICATION_THROTTLED`. */
  check(who: {
    tenantId: string;
    userId: string;
    ip: string | undefined;
  }): Promise<void>;
}

// The three limits on `requestEmailVerification`, on top of janus's per-address
// one (5 per 10 min): per user (the signed-in account), per client address and
// tenant, and per tenant. The address and tenant pair is the shared one
// (`ipAndTenantLimits`); the user key starts with the tenant id as they do.
export const verificationLimits = (config: VerificationLimitConfig) => {
  const { ip, tenant } = ipAndTenantLimits("verify", config);
  return {
    verifyIp: ip,
    verifyTenant: tenant,
    verifyUser: defineRateLimit({
      name: "verify-user",
      key: (who: { tenantId: string; userId: string }) =>
        `${who.tenantId}/${who.userId}`,
      limit: config.userLimit,
      per: config.userWindowSeconds * 1000,
    }),
  };
};

/** `EMAIL_VERIFICATION_THROTTLED`, 429, `retryAfter` in the error and `Retry-After` (seconds). */
export const emailVerificationThrottled = (retryAfter: number) =>
  new GraphQLError("Too many verification e-mails requested", {
    extensions: {
      code: "EMAIL_VERIFICATION_THROTTLED",
      retryAfter,
      http: { status: 429, headers: { "retry-after": String(retryAfter) } },
    },
  });

// A slow Redis must not hold a request open (as in the shared core).
const REDIS_TIMEOUT_MS = 250;

/**
 * The user first (a refused user spends no address or tenant budget), then
 * the address and the tenant over the shared core. Redis down or slow: the
 * request goes through, logged; janus's per-address limit still holds.
 */
export function createVerificationThrottle(
  limits: {
    verifyUser: {
      consume(
        params: { tenantId: string; userId: string },
        cost?: number,
        options?: { timeoutMs: number },
      ): Promise<LimitResult>;
    };
    verifyIp: BoundLimits["ip"];
    verifyTenant: BoundLimits["tenant"];
  },
  log: (message: string) => void = (message) => console.warn(message),
): VerificationThrottle {
  const shared = createThrottle(
    { ip: limits.verifyIp, tenant: limits.verifyTenant },
    (result) => emailVerificationThrottled(retryAfterSeconds(result)),
    "e-mail verification limits",
    log,
  );
  return {
    async check({ tenantId, userId, ip }) {
      let byUser: LimitResult | undefined;
      try {
        byUser = await limits.verifyUser.consume({ tenantId, userId }, 1, {
          timeoutMs: REDIS_TIMEOUT_MS,
        });
      } catch (error) {
        const reason =
          error instanceof GuardError ? error.code : "connection failed";
        log(
          `redis unavailable: e-mail verification limits skipped (${reason})`,
        );
      }
      if (byUser !== undefined && !byUser.allowed) {
        throw emailVerificationThrottled(retryAfterSeconds(byUser));
      }
      await shared.check({ tenantId, ip });
    },
  };
}
