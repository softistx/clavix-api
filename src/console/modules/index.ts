import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  users,
  usersAudits,
  usersGuards,
} from "@/modules/users/users.console-resolver";
import type { Audits } from "../audit";
import type { Guards } from "../guard";
import { admins, adminsAudits, adminsGuards } from "./admins";
import { audit, auditAudits, auditGuards } from "./audit";
import { branding, brandingAudits, brandingGuards } from "./branding";
import { clients, clientsAudits, clientsGuards } from "./clients";
import {
  connections,
  connectionsAudits,
  connectionsGuards,
} from "./connections";
import { domains, domainsAudits, domainsGuards } from "./domains";
import { me, meGuards } from "./me";
import {
  oauthPolicy,
  oauthPolicyAudits,
  oauthPolicyGuards,
} from "./oauth-policy";
import { resources, resourcesAudits, resourcesGuards } from "./resources";
import { roles, rolesAudits, rolesGuards } from "./roles";
import {
  signInMethods,
  signInMethodsAudits,
  signInMethodsGuards,
} from "./sign-in-methods";
import { tenants, tenantsAudits, tenantsGuards } from "./tenants";
import { webhooks, webhooksAudits, webhooksGuards } from "./webhooks";

// One entry per module: its resolvers, the guard of each root field it adds
// and the audit action of each mutation it adds. A root field with no guard is
// denied (guard.ts); a mutation with no audit action fails audit.spec.ts.
export const resolvers: Resolvers = mergeResolvers([
  me,
  audit,
  admins,
  branding,
  signInMethods,
  oauthPolicy,
  clients,
  domains,
  resources,
  roles,
  tenants,
  users,
  webhooks,
  connections,
]);
export const guards: Guards = {
  ...meGuards,
  ...auditGuards,
  ...adminsGuards,
  ...brandingGuards,
  ...clientsGuards,
  ...domainsGuards,
  ...resourcesGuards,
  ...rolesGuards,
  ...tenantsGuards,
  ...signInMethodsGuards,
  ...oauthPolicyGuards,
  ...usersGuards,
  ...webhooksGuards,
  ...connectionsGuards,
};
export const audits: Audits = {
  ...auditAudits,
  ...adminsAudits,
  ...brandingAudits,
  ...clientsAudits,
  ...domainsAudits,
  ...resourcesAudits,
  ...rolesAudits,
  ...tenantsAudits,
  ...signInMethodsAudits,
  ...oauthPolicyAudits,
  ...usersAudits,
  ...webhooksAudits,
  ...connectionsAudits,
};
