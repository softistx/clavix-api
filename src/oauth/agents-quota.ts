import type { Exclusive } from "@/console/exclusive";
import { assertWithinQuota, QuotaExceededError } from "@/modules/usage";

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * The `Exclusive` key of a tenant's agent registrations: the count, the
 * registration and the record run under it, so concurrent registrations
 * cannot all see room for one more.
 */
export const agentsQuotaKey = (tenantId: string) => `oauth:agents:${tenantId}`;

/** What `/register` and a metadata first use share: the lock and the count. */
export interface AgentsQuotaGate {
  exclusive: Exclusive;
  count: (tenantId: string) => Promise<number>;
  quotaOf: (tenantId: string) => Promise<number | null>;
}

/** The 403 `access_denied` when the tenant's `agents` quota is reached, otherwise `null`. */
export async function agentsQuotaRefusal(
  gate: Pick<AgentsQuotaGate, "count" | "quotaOf">,
  tenantId: string,
): Promise<Response | null> {
  try {
    assertWithinQuota(
      "agents",
      await gate.count(tenantId),
      await gate.quotaOf(tenantId),
    );
    return null;
  } catch (error) {
    if (!(error instanceof QuotaExceededError)) throw error;
    return Response.json(
      { error: "access_denied", error_description: error.message },
      { status: 403, headers: NO_STORE },
    );
  }
}

/** Without Redis a lock is in-process; with it, one that cannot be taken is a retryable 503. */
export const lockUnavailable = (error: unknown): Response | null => {
  const code = (error as { extensions?: { code?: unknown } } | null)?.extensions
    ?.code;
  return code === "SERVICE_UNAVAILABLE"
    ? Response.json(
        {
          error: "temporarily_unavailable",
          error_description: "Try again later",
        },
        { status: 503, headers: { ...NO_STORE, "retry-after": "1" } },
      )
    : null;
};
