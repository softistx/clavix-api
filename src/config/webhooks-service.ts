import { lookup } from "node:dns/promises";
import { type UrlPolicy, WebhooksService } from "@/modules/webhooks";
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

/** The webhook endpoints of the tenants and their delivery attempts (W2). The collections are tenant-owned: only this wiring and the module reach them. */
export const webhooksService = new WebhooksService(
  mongo.db.webhookEndpoints,
  mongo.db.webhookDeliveries,
  webhookSecretBox,
  { policy: urlPolicy },
);
