import type { ObjectId } from "mongodb";
import type { WebhookEndpointParent } from "./webhooks.console-parent";
import type { EndpointSecret } from "./webhooks.model";
import { DELIVERIES_PER_ENDPOINT } from "./webhooks.model";
import type {
  AttemptRecord,
  DeliveryEndpoint,
  WebhookDeliveryDoc,
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

/** What an admin event names: the endpoint and its tenant. Never the URL or a secret. */
export const endpointTarget = (tenantId: ObjectId, id: string) => ({
  type: "webhookEndpoint",
  id,
  tenantId: tenantId.toHexString(),
});

/** The `Exclusive` key of a tenant's endpoints (the quota count and the insert are not atomic). */
export const webhooksKey = (tenant: { _id: ObjectId }) =>
  `console:webhooks:${tenant._id.toHexString()}`;

/** An endpoint as the console shows it (its tenant's id kept for `deliveries`). */
export const endpointShape = (
  doc: WebhookEndpointDoc,
): WebhookEndpointParent => ({
  tenantId: doc.tenantId.toHexString(),
  id: doc._id.toHexString(),
  url: doc.url,
  description: doc.description,
  types: doc.types,
  enabled: doc.enabled,
  disabledReason:
    doc.disabledReason === null
      ? null
      : ((doc.disabledReason === "givenUp" ? "GIVEN_UP" : "MANUAL") as
          | "GIVEN_UP"
          | "MANUAL"),
  consecutiveGiveUps: doc.consecutiveGiveUps,
  secrets: doc.secrets.map(({ createdAt, expiresAt }) => ({
    createdAt,
    expiresAt,
  })),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/** One delivery attempt as the console shows it. */
export const attemptShape = (doc: WebhookDeliveryDoc) => ({
  id: doc._id.toHexString(),
  eventId: doc.eventId,
  type: doc.type,
  attempt: doc.attempt,
  status: doc.status,
  error: doc.error,
  durationMs: doc.durationMs,
  delivered: doc.delivered,
  willRetry: doc.willRetry,
  at: doc.at,
});
