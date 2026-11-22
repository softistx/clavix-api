// Every collection of the app, under the key the Mongo exposes it by
// (its key on `mongo.db`): src/config/db.ts wires this module object. A module
// adds its models here.

export { oauthSigningKeys } from "@softistx/janus-oauth-mongo";
export { adminEvents } from "../console/admin-events/admin-events.model";
export { agentClients } from "./agents/agents.model";
export { userAttributes } from "./attributes/attributes.model";
export { authEvents } from "./audit/audit.model";
export { branding } from "./branding/branding.model";
export { clientPolicies } from "./client-policies/client-policies.model";
export { connections } from "./connections/connections.model";
export { domains } from "./domains/domains.model";
export { detailTypes, resources, scopes } from "./resources/resources.model";
export { roleAssignments, roles } from "./roles/roles.model";
export { tenants } from "./tenants/tenants.model";
export { usageCounters } from "./usage/usage.model";
export { webhookDeliveries, webhookEndpoints } from "./webhooks/webhooks.model";
