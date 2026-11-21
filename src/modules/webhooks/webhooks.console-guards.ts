import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

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
