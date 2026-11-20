import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

/** How long an attempt is kept (M4 W2). */
export const DELIVERY_RETENTION_SECONDS = 7 * 24 * 60 * 60;
/** The attempts kept per endpoint, the newest ones. */
export const DELIVERIES_PER_ENDPOINT = 100;

// One request of a webhook delivery, as janus-webhooks' `onAttempt` reports it
// (M4 W2): why an endpoint fails, for an admin. Tenant-owned (ADR-0006): read
// and written only through `scopeToTenant`. It never holds the request or the
// response body, the URL or a header; `error` is the failure's name
// (`TimeoutError`), not its message. A document leaves after 7 days (the TTL
// index on `at`) or when the endpoint already has 100 newer ones.
export const webhookDeliveries = defineCollection({
  name: "webhookDeliveries",
  schema: z.strictObject({
    _id: id(),
    ...tenantField,
    endpointId: z.string().length(24),
    eventId: z.string().max(100),
    type: z.string().max(100),
    /** 1-based: the request's rank among the delivery's. */
    attempt: z.number().int().min(1),
    /** The response's status; `null` when there was none (a timeout, a refused address). */
    status: z.number().int().nullable(),
    error: z.string().max(100).nullable(),
    durationMs: z.number().int().min(0),
    delivered: z.boolean(),
    /** `false` once delivered or given up. */
    willRetry: z.boolean(),
    at: z.date(),
  }),
  indexes: [
    {
      key: { tenantId: 1, endpointId: 1, at: -1 },
      name: "webhookDeliveries_tenant_endpoint_at",
    },
    {
      key: { at: 1 },
      expireAfterSeconds: DELIVERY_RETENTION_SECONDS,
      name: "webhookDeliveries_ttl",
    },
  ],
});

export type StoredWebhookDeliveries = typeof webhookDeliveries;
