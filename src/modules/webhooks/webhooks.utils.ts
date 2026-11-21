import type { EndpointSecret } from "./webhooks.model";
import { DELIVERIES_PER_ENDPOINT } from "./webhooks.model";
import type {
  AttemptRecord,
  DeliveryEndpoint,
  WebhookEndpointDoc,
} from "./webhooks.types";

/** The context a secret is sealed with: its tenant and its endpoint. */
export const contextOf = (tenantId: string, endpointId: string) =>
  `${tenantId}:${endpointId}`;

/** The attempts a console page shows at most. */
export const MAX_LISTED = DELIVERIES_PER_ENDPOINT;

/** The page size asked for, held between 1 and `MAX_LISTED`. */
export const clampLimit = (limit: number) =>
  Math.min(Math.max(limit, 1), MAX_LISTED);

/** An endpoint as `webhooks()` takes it, from its opened secrets; `undefined` with none. */
export function deliveryEndpointOf(
  doc: WebhookEndpointDoc,
  secrets: readonly string[],
): DeliveryEndpoint | undefined {
  const [first, ...rest] = secrets;
  if (first === undefined) return undefined;
  return {
    id: doc._id.toHexString(),
    url: doc.url,
    secrets: [first, ...rest],
    ...(doc.types.length === 0 ? {} : { types: doc.types }),
    disabled: !doc.enabled,
  };
}

/** The secrets of `entries` still sealed under another key than `kid`. */
export const behindCount = (entries: readonly EndpointSecret[], kid: string) =>
  entries.filter((entry) => entry.sealed.kid !== kid).length;

/** An attempt as stored: the duration whole and never negative. */
export const attemptDoc = (attempt: AttemptRecord, at: Date) => ({
  endpointId: attempt.endpointId,
  eventId: attempt.eventId,
  type: attempt.type,
  attempt: attempt.attempt,
  status: attempt.status,
  error: attempt.error,
  durationMs: Math.max(0, Math.round(attempt.durationMs)),
  delivered: attempt.delivered,
  willRetry: attempt.willRetry,
  at,
});
