import { lookup } from "node:dns/promises";
import type { UrlPolicy } from "@/modules/webhooks/url-policy";
import { WebhookDeliveriesService } from "@/modules/webhooks/webhook-deliveries.service";
import { WebhookEndpointsService } from "@/modules/webhooks/webhook-endpoints.service";
import { mongo } from "./db";
import { env } from "./env";
import { webhookSecretBox } from "./keys";

/**
 * Where an endpoint may point (D21): public addresses only, every name looked
 * up again on every send. `CLAVIX_WEBHOOKS_ALLOW_PRIVATE` lifts it, outside
 * production only (the environment refuses it there).
 */
export const urlPolicy: UrlPolicy = {
  resolve: async (host) =>
    (await lookup(host, { all: true })).map(({ address }) => address),
  allowPrivate: env.CLAVIX_WEBHOOKS_ALLOW_PRIVATE,
};

/** The webhook endpoints of the tenants. The collection is tenant-owned: only this wiring and its module reach it. */
export const webhookEndpoints = new WebhookEndpointsService(
  mongo.db.webhookEndpoints,
  webhookSecretBox,
  { policy: urlPolicy },
);

/** The delivery attempts of the tenants' endpoints (W2); the collection is tenant-owned and reached only here and in its module. */
export const webhookDeliveries = new WebhookDeliveriesService(
  mongo.db.webhookDeliveries,
);
