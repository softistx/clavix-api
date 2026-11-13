// Every collection of the app, under the key the Mongo exposes it by
// (its key on `mongo.db`): src/config/db.ts wires this module object. A module
// adds its models here.

export { oauthSigningKeys } from "@softistx/janus-oauth-mongo";
export { adminEvents } from "../console/admin-events/admin-events.model";
export { branding } from "./branding/branding.model";
export { resources } from "./resources/resources.model";
export { scopes } from "./resources/scopes.model";
export { roleAssignments, roles } from "./roles/roles.model";
export { tenants } from "./tenants/tenants.model";
export { usageCounters } from "./usage/usage.model";
