import { defineRateLimit } from "@softistx/redis";
import {
  type Bound,
  consumeOrSkip,
  retryAfterSeconds,
} from "@/http/throttle/core";

export interface ExportLimitConfig {
  /** Exports one tenant may start per `windowSeconds`. */
  limit: number;
  windowSeconds: number;
}

// An export reads up to 100 000 rows: a small budget per tenant (GCRA, so it
// refills evenly), whoever asks.
export const exportLimits = (config: ExportLimitConfig) => ({
  auditExport: defineRateLimit({
    name: "audit-export",
    key: (who: { tenantId: string }) => who.tenantId,
    limit: config.limit,
    per: config.windowSeconds * 1000,
  }),
});

/** Counts one export for the tenant: the seconds to wait when it is over budget, `null` when allowed. */
export type ExportThrottle = (tenantId: string) => Promise<number | null>;

/** Redis down or slow: the export goes through, logged (it is authenticated and audited). */
export function createExportThrottle(
  limit: Bound<{ tenantId: string }>,
  log: (message: string) => void = (message) => console.warn(message),
): ExportThrottle {
  return async (tenantId) => {
    const result = await consumeOrSkip(
      limit,
      { tenantId },
      "audit export limit",
      log,
    );
    return result === undefined || result.allowed
      ? null
      : retryAfterSeconds(result);
  };
}
