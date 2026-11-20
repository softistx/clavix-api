import { type FieldLimit, fieldRateLimit } from "@alxia/graphql";
import { defineRateLimit, type LimitResult } from "@softistx/redis";
import { GraphQLError } from "graphql";
import {
  type Bound,
  consumeOrSkip,
  retryAfterSeconds,
} from "@/http/throttle/core";
import type { ConsoleContext } from "./context";

export interface ConsoleLimitConfig {
  /** Test events one webhook endpoint may be sent per `testWindowSeconds`. */
  testEndpointLimit: number;
  /** Test events one tenant may send, all its endpoints together, per `testWindowSeconds`. */
  testTenantLimit: number;
  testWindowSeconds: number;
  /** Invitations one caller may issue with each of `inviteUser` and `inviteAdmin`, per `inviteCallerWindowSeconds`. */
  inviteCallerLimit: number;
  inviteCallerWindowSeconds: number;
  /** Invitation mails one tenant may send (users and admins together), per `inviteTenantWindowSeconds`. */
  inviteTenantLimit: number;
  inviteTenantWindowSeconds: number;
}

// The budgets of the console mutations that make the platform act outside it
// for a tenant admin: a test webhook holds a slot of the shared delivery queue
// (G2-02), an invitation sends a mail from the platform's address (G2-04).
// `@softistx/redis` rate limits (GCRA: the bucket starts full and refills
// evenly), every key led by what it counts for, so a tenant's or a caller's
// traffic never spends another's.
export const consoleLimits = (config: ConsoleLimitConfig) => ({
  webhookTestEndpoint: defineRateLimit({
    name: "webhook-test-endpoint",
    key: (who: { tenantId: string; endpointId: string }) =>
      `${who.tenantId}/${who.endpointId}`,
    limit: config.testEndpointLimit,
    per: config.testWindowSeconds * 1000,
  }),
  webhookTestTenant: defineRateLimit({
    name: "webhook-test-tenant",
    key: (who: { tenantId: string }) => who.tenantId,
    limit: config.testTenantLimit,
    per: config.testWindowSeconds * 1000,
  }),
  // The key is `@alxia/graphql`'s `<field>:<caller>`: one bucket per mutation and caller.
  inviteCaller: defineRateLimit({
    name: "invite-caller",
    key: (who: { caller: string }) => who.caller,
    limit: config.inviteCallerLimit,
    per: config.inviteCallerWindowSeconds * 1000,
  }),
  inviteTenant: defineRateLimit({
    name: "invite-tenant",
    key: (who: { tenantId: string }) => who.tenantId,
    limit: config.inviteTenantLimit,
    per: config.inviteTenantWindowSeconds * 1000,
  }),
});

/** The console's refusal past a budget: `RATE_LIMITED`, 429, `retryAfter` (seconds) in the error and `Retry-After`. */
export const rateLimited = (retryAfter: number) =>
  new GraphQLError("Too many requests", {
    extensions: {
      code: "RATE_LIMITED",
      retryAfter,
      http: { status: 429, headers: { "retry-after": String(retryAfter) } },
    },
  });

/**
 * What the console's mutations spend (`ctx.budgets`; none without Redis).
 * Each call counts one and throws `rateLimited` past a limit.
 */
export interface ConsoleBudgets {
  /** One test event: the endpoint first (a refused endpoint spends nothing of the tenant's), then the tenant. */
  testWebhook(who: { tenantId: string; endpointId: string }): Promise<void>;
  /** One invitation mail of the tenant, `inviteUser` and `inviteAdmin` together. */
  invitation(who: { tenantId: string }): Promise<void>;
  /**
   * The per-caller budget of `inviteUser` and `inviteAdmin`, counted per
   * selection by `useInviteBudget` before the operation runs.
   */
  readonly inviteCaller: FieldLimit;
}

const SKIPPED = "console budgets";

/**
 * The budgets over the app's Redis limits. Redis down or slow: the call goes
 * through, logged (the console is authenticated and every mutation audited),
 * as the audit export's budget does.
 */
export function createConsoleBudgets(
  limits: {
    webhookTestEndpoint: Bound<{ tenantId: string; endpointId: string }>;
    webhookTestTenant: Bound<{ tenantId: string }>;
    inviteCaller: Bound<{ caller: string }>;
    inviteTenant: Bound<{ tenantId: string }>;
  },
  log: (message: string) => void = (message) => console.warn(message),
): ConsoleBudgets {
  const spend = async <P>(limit: Bound<P>, params: P, cost = 1) => {
    const result = await consumeOrSkip(limit, params, SKIPPED, log, cost);
    return result === undefined || result.allowed ? null : result;
  };
  const refuse = (result: LimitResult | null) => {
    if (result !== null) throw rateLimited(retryAfterSeconds(result));
  };
  return {
    async testWebhook({ tenantId, endpointId }) {
      refuse(await spend(limits.webhookTestEndpoint, { tenantId, endpointId }));
      refuse(await spend(limits.webhookTestTenant, { tenantId }));
    },
    async invitation({ tenantId }) {
      refuse(await spend(limits.inviteTenant, { tenantId }));
    },
    inviteCaller: {
      async consume(key, cost) {
        const result = await spend(limits.inviteCaller, { caller: key }, cost);
        return result === null
          ? { allowed: true, retryAfter: 0 }
          : { allowed: false, retryAfter: result.retryAfter };
      },
    },
  };
}

/**
 * The per-caller invitation budget as `@alxia/graphql`'s `fieldRateLimit`: it
 * counts every selection of `inviteUser` and `inviteAdmin` in the operation
 * about to run (aliases and fragments expanded) and consumes that many for the
 * token's user, so one POST of N aliased invitations costs N. Past the budget
 * nothing runs: 429 `RATE_LIMITED`, `extensions.retryAfter` and `Retry-After`.
 * Listed first in the console's plugins.
 */
export const useInviteBudget = (limit: FieldLimit) =>
  fieldRateLimit<ConsoleContext>({
    key: (ctx) => ctx.principal?.userId,
    fields: { inviteUser: limit, inviteAdmin: limit },
  });
