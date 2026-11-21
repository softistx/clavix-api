import { ObjectId } from "mongodb";
import { tenantsService } from "@/config/tenancy";
import {
  webhookEndpoints as endpoints,
  webhookDeliveries,
} from "@/config/webhook-endpoints";
import { webhookDelivery } from "@/config/webhooks";
import type { Resolvers } from "@/generated/console/resolvers";
import { effectiveQuotas } from "@/modules/tenants";
import { WEBHOOK_EVENT_TYPES } from "@/modules/webhooks/events";
import type { WebhookEndpointDoc } from "@/modules/webhooks/webhook-endpoints.service";
import { WebhookError } from "@/modules/webhooks/webhooks.errors";
import { fail } from "@/shared/errors";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { catalogTenant } from "../catalog-support";
import { tenantArg } from "../ids";
import { refusal } from "../tenants/errors";
import type { WebhookEndpointParent } from "./parent";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const webhooksGuards: Guards = {
  "Query.webhookEndpoints": view,
  "Query.webhookEndpoint": view,
  "Query.webhookEventTypes": view,
  "Mutation.createWebhookEndpoint": edit,
  "Mutation.updateWebhookEndpoint": edit,
  "Mutation.deleteWebhookEndpoint": edit,
  "Mutation.rollWebhookSecret": edit,
  "Mutation.sendTestWebhook": edit,
};

export const webhooksAudits: Audits = {
  "Mutation.createWebhookEndpoint": "webhook.create",
  "Mutation.updateWebhookEndpoint": "webhook.update",
  "Mutation.deleteWebhookEndpoint": "webhook.delete",
  "Mutation.rollWebhookSecret": "webhook.rollSecret",
  "Mutation.sendTestWebhook": "webhook.test",
};

const STATUS = { BAD_USER_INPUT: 400, NOT_FOUND: 404 } as const;

// The service's refusals as the contract's GraphQL errors (the quota one too).
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof WebhookError) {
      throw fail(error.code, error.message, {
        status: STATUS[error.code],
        field: error.field,
      });
    }
    throw refusal(error);
  }
}

// What an admin event names: the endpoint and its tenant. Never the URL or a secret.
const target = (tenantId: ObjectId, id: string) => ({
  type: "webhookEndpoint",
  id,
  tenantId: tenantId.toHexString(),
});

/** The `Exclusive` key of a tenant's endpoints (the quota count and the insert are not atomic). */
const webhooksKey = (tenant: { _id: ObjectId }) =>
  `console:webhooks:${tenant._id.toHexString()}`;

const shape = (doc: WebhookEndpointDoc): WebhookEndpointParent => ({
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

export const webhooks: Resolvers = {
  WebhookEndpoint: {
    // Under the endpoint's own `view` guard: it is reached through a guarded query or mutation.
    deliveries: async (endpoint, { first }) =>
      (
        await webhookDeliveries.list(
          endpoint.tenantId,
          endpoint.id,
          first ?? undefined,
        )
      ).map((doc) => ({
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
      })),
  },
  Query: {
    webhookEndpoints: async (_, { tenantId }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      return (await endpoints.list(tenant._id.toHexString())).map(shape);
    },
    webhookEndpoint: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const found = await endpoints.find(tenant._id.toHexString(), id);
      return found === undefined ? null : shape(found);
    },
    webhookEventTypes: async (_, { tenantId }, ctx) => {
      await catalogTenant(ctx, tenantId);
      return [...WEBHOOK_EVENT_TYPES];
    },
  },
  Mutation: {
    createWebhookEndpoint: async (_, { tenantId, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const stored = await tenantsService.find(tenant._id.toHexString());
      const quota = stored === undefined ? 0 : effectiveQuotas(stored).webhooks;
      const created = await ctx.exclusive(webhooksKey(tenant), () =>
        refusing(() =>
          endpoints.create(
            tenant._id.toHexString(),
            {
              url: input.url,
              description: input.description ?? undefined,
              types: input.types ?? undefined,
            },
            quota,
          ),
        ),
      );
      await ctx.audit(
        "webhook.create",
        target(tenant._id, created.endpoint._id.toHexString()),
      );
      return { endpoint: shape(created.endpoint), secret: created.secret };
    },
    updateWebhookEndpoint: async (_, { tenantId, id, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const updated = await refusing(() =>
        endpoints.update(tenant._id.toHexString(), id, {
          url: input.url ?? undefined,
          description: input.description ?? undefined,
          types: input.types ?? undefined,
          enabled: input.enabled ?? undefined,
        }),
      );
      await ctx.audit("webhook.update", target(tenant._id, id));
      return shape(updated);
    },
    deleteWebhookEndpoint: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      let removed = true;
      try {
        await endpoints.delete(tenant._id.toHexString(), id);
        await webhookDeliveries.deleteForEndpoint(tenant._id.toHexString(), id);
      } catch (error) {
        if (!(error instanceof WebhookError) || error.code !== "NOT_FOUND") {
          throw refusal(error);
        }
        removed = false;
      }
      // Recorded on a repeat too (it may be the event the first run missed).
      if (ObjectId.isValid(id)) {
        await ctx.audit(
          "webhook.delete",
          target(tenant._id, new ObjectId(id).toHexString()),
        );
      }
      return removed;
    },
    rollWebhookSecret: async (_, { tenantId, id, keepPrevious }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      // Under the tenant's lock: two rolls would otherwise overwrite each other's secret.
      const rolled = await ctx.exclusive(webhooksKey(tenant), () =>
        refusing(() =>
          endpoints.roll(tenant._id.toHexString(), id, keepPrevious),
        ),
      );
      await ctx.audit("webhook.rollSecret", target(tenant._id, id));
      return { endpoint: shape(rolled.endpoint), secret: rolled.secret };
    },
    sendTestWebhook: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const hex = tenant._id.toHexString();
      const endpoint = await refusing(async () => {
        const found = await endpoints.find(hex, id);
        if (found === undefined) {
          throw new WebhookError("NOT_FOUND", "No such webhook endpoint");
        }
        if (!found.enabled) {
          throw new WebhookError(
            "BAD_USER_INPUT",
            "The endpoint is switched off",
            "id",
          );
        }
        // One test event of this endpoint and tenant (G2-02), before the address check and the queue.
        await ctx.budgets?.testWebhook({ tenantId: hex, endpointId: id });
        // The address is checked again on send, by the delivery's fetch; the
        // console says so now rather than a silent give-up later.
        await endpoints.checkAddress(found.url);
        return found;
      });
      const eventId = await webhookDelivery.sendTest(
        hex,
        endpoint._id.toHexString(),
      );
      await ctx.audit("webhook.test", target(tenant._id, id));
      return eventId;
    },
  },
};
