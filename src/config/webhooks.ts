import { createMemoryWebhookQueue } from "@softistx/janus-webhooks";
import { createRedisWebhookQueue } from "@softistx/janus-webhooks-redis";
import { senderAddress } from "@/mail/mailer";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import {
  createWebhookDelivery,
  DISABLE_ACTOR,
  webhookQueueLimits,
} from "@/modules/webhooks/delivery";
import { disabledEndpointMail } from "@/modules/webhooks/notice";
import { pruneWebhookSecrets } from "@/modules/webhooks/secrets-prune";
import { guardedFetch } from "@/modules/webhooks/url-policy";
import { access } from "./access";
import { adminEventRecorder } from "./admin-events";
import { env } from "./env";
import { eventBus } from "./events";
import { mailer } from "./mail";
import { redis } from "./redis";
import { tenantResolver, tenantsService } from "./tenancy";
import { forTenant } from "./users";
import {
  urlPolicy,
  webhookDeliveries,
  webhookEndpoints,
} from "./webhook-endpoints";

// The console's users are the `clavix` tenant's; its owners are mailed.
const findOwner = async (id: string) => {
  const tenant = await tenantResolver.resolveHost(
    `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
  );
  return tenant === null
    ? null
    : ((await (await forTenant(tenant))?.findUser(id)) ?? null);
};

// The queue's caps (G2-03): per tenant, from the environment.
const queueLimits = webhookQueueLimits({
  maxInFlight: env.CLAVIX_WEBHOOKS_MAX_IN_FLIGHT,
  maxPending: env.CLAVIX_WEBHOOKS_MAX_PENDING,
});

/**
 * The process-wide delivery (D20) over the real stores: the Redis queue when
 * Redis is configured (a retry then outlives the process), the memory one
 * otherwise. An endpoint switched off after 5 given-up deliveries in a row
 * records `webhook.disable` (actor `system:webhooks:disable`) and mails the
 * tenant's owners.
 */
export const webhookDelivery = createWebhookDelivery({
  endpoints: webhookEndpoints,
  deliveries: webhookDeliveries,
  fetch: guardedFetch(urlPolicy),
  queue:
    redis === undefined
      ? createMemoryWebhookQueue(queueLimits)
      : createRedisWebhookQueue(redis.connection, {
          prefix: "clavix:webhooks:",
          ...queueLimits,
        }),
  onDisabled: async ({ tenantId, endpointId }) => {
    await adminEventRecorder.record({
      actor: DISABLE_ACTOR,
      action: "webhook.disable",
      tenantId,
      target: { type: "webhookEndpoint", id: endpointId },
      requestId: crypto.randomUUID(),
    });
    const [tenant, endpoint] = await Promise.all([
      tenantsService.find(tenantId),
      webhookEndpoints.find(tenantId, endpointId),
    ]);
    if (tenant === undefined || endpoint === undefined) return;
    const owners = await Promise.all(
      (await access.owners(tenantId)).map((id) => findOwner(id)),
    );
    const to = owners.flatMap((owner) => (owner === null ? [] : [owner.email]));
    if (to.length === 0) return;
    await mailer.send(
      disabledEndpointMail({
        to,
        from: { name: "Clavix", address: senderAddress(env.CLAVIX_DOMAIN) },
        tenantName: tenant.name,
        url: endpoint.url,
      }),
    );
  },
});

// The relay is the bus's subscriber: every janus user event, and the sign-in
// log's successful sign-ins as `session.signedIn`.
eventBus.subscribe(webhookDelivery.relay);

/** The daily clean-up of the expired rolled secrets over the real stores. */
export const createWebhookSecretsPrune =
  (now: () => Date = () => new Date()) =>
  () =>
    pruneWebhookSecrets(
      {
        tenantIds: () => tenantsService.activeIds(),
        prune: (tenantId, at) =>
          webhookEndpoints.pruneExpiredSecrets(tenantId, at),
      },
      now(),
    );
