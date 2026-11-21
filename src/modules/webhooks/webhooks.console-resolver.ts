import { ObjectId } from "mongodb";
import { tenantsService } from "@/config/tenancy";
import { webhookDelivery } from "@/config/webhooks";
import { webhooksService } from "@/config/webhooks-service";
import { catalogTenant } from "@/console/modules/catalog-support";
import { refusal } from "@/console/modules/refusal";
import type { Resolvers } from "@/generated/console/resolvers";
import { effectiveQuotas } from "@/modules/tenants";
import { refusing } from "./webhooks.console-support";
import { WebhookError } from "./webhooks.errors";
import { WEBHOOK_EVENT_TYPES } from "./webhooks.events";
import {
  attemptShape,
  endpointShape,
  endpointTarget,
  webhooksKey,
} from "./webhooks.utils";

export { webhooksAudits, webhooksGuards } from "./webhooks.console-guards";

export const webhooks: Resolvers = {
  WebhookEndpoint: {
    // Under the endpoint's own `view` guard: it is reached through a guarded query or mutation.
    deliveries: async (endpoint, { first }) =>
      (
        await webhooksService.listAttempts(
          endpoint.tenantId,
          endpoint.id,
          first ?? undefined,
        )
      ).map(attemptShape),
  },
  Query: {
    webhookEndpoints: async (_, { tenantId }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      return (
        await webhooksService.listEndpoints(tenant._id.toHexString())
      ).map(endpointShape);
    },
    webhookEndpoint: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const found = await webhooksService.findEndpoint(
        tenant._id.toHexString(),
        id,
      );
      return found === undefined ? null : endpointShape(found);
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
          webhooksService.createEndpoint(
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
        endpointTarget(tenant._id, created.endpoint._id.toHexString()),
      );
      return {
        endpoint: endpointShape(created.endpoint),
        secret: created.secret,
      };
    },
    updateWebhookEndpoint: async (_, { tenantId, id, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const updated = await refusing(() =>
        webhooksService.updateEndpoint(tenant._id.toHexString(), id, {
          url: input.url ?? undefined,
          description: input.description ?? undefined,
          types: input.types ?? undefined,
          enabled: input.enabled ?? undefined,
        }),
      );
      await ctx.audit("webhook.update", endpointTarget(tenant._id, id));
      return endpointShape(updated);
    },
    deleteWebhookEndpoint: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      let removed = true;
      try {
        await webhooksService.deleteEndpoint(tenant._id.toHexString(), id);
        await webhooksService.deleteAttempts(tenant._id.toHexString(), id);
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
          endpointTarget(tenant._id, new ObjectId(id).toHexString()),
        );
      }
      return removed;
    },
    rollWebhookSecret: async (_, { tenantId, id, keepPrevious }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      // Under the tenant's lock: two rolls would otherwise overwrite each other's secret.
      const rolled = await ctx.exclusive(webhooksKey(tenant), () =>
        refusing(() =>
          webhooksService.rollSecret(
            tenant._id.toHexString(),
            id,
            keepPrevious,
          ),
        ),
      );
      await ctx.audit("webhook.rollSecret", endpointTarget(tenant._id, id));
      return {
        endpoint: endpointShape(rolled.endpoint),
        secret: rolled.secret,
      };
    },
    sendTestWebhook: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const hex = tenant._id.toHexString();
      const endpoint = await refusing(async () => {
        const found = await webhooksService.findEndpoint(hex, id);
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
        await ctx.budgets.testWebhook({ tenantId: hex, endpointId: id });
        // The address is checked again on send, by the delivery's fetch; the
        // console says so now rather than a silent give-up later.
        await webhooksService.checkAddress(found.url);
        return found;
      });
      const eventId = await webhookDelivery.sendTest(
        hex,
        endpoint._id.toHexString(),
      );
      await ctx.audit("webhook.test", endpointTarget(tenant._id, id));
      return eventId;
    },
  },
};
