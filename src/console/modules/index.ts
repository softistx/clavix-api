import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Audits } from "../audit";
import type { Guards } from "../guard";
import { branding, brandingAudits, brandingGuards } from "./branding";
import { clients, clientsAudits, clientsGuards } from "./clients";
import { me, meGuards } from "./me";
import { resources, resourcesAudits, resourcesGuards } from "./resources";
import { tenants, tenantsAudits, tenantsGuards } from "./tenants";

// One entry per module: its resolvers, the guard of each root field it adds
// and the audit action of each mutation it adds. A root field with no guard is
// denied (guard.ts); a mutation with no audit action fails audit.spec.ts.
export const resolvers: Resolvers = mergeResolvers([
  me,
  branding,
  clients,
  resources,
  tenants,
]);
export const guards: Guards = {
  ...meGuards,
  ...brandingGuards,
  ...clientsGuards,
  ...resourcesGuards,
  ...tenantsGuards,
};
export const audits: Audits = {
  ...brandingAudits,
  ...clientsAudits,
  ...resourcesAudits,
  ...tenantsAudits,
};
