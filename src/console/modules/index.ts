import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  admins,
  adminsAudits,
  adminsGuards,
} from "@/modules/admins/admins.console-resolver";
import {
  audit,
  auditAudits,
  auditGuards,
} from "@/modules/audit/audit.console-resolver";
import {
  branding,
  brandingAudits,
  brandingGuards,
} from "@/modules/branding/branding.console-resolver";
import {
  clients,
  clientsAudits,
  clientsGuards,
} from "@/modules/clients/clients.console-resolver";
import {
  connections,
  connectionsAudits,
  connectionsGuards,
} from "@/modules/connections/connections.console-resolver";
import {
  domains,
  domainsAudits,
  domainsGuards,
} from "@/modules/domains/domains.console-resolver";
import {
  oauthPolicy,
  oauthPolicyAudits,
  oauthPolicyGuards,
} from "@/modules/oauth-policy/oauth-policy.console-resolver";
import {
  resources,
  resourcesAudits,
  resourcesGuards,
} from "@/modules/resources/resources.console-resolver";
import {
  roles,
  rolesAudits,
  rolesGuards,
} from "@/modules/roles/roles.console-resolver";
import {
  signInMethods,
  signInMethodsAudits,
  signInMethodsGuards,
} from "@/modules/sign-in-methods/sign-in-methods.console-resolver";
import {
  users,
  usersAudits,
  usersGuards,
} from "@/modules/users/users.console-resolver";
import {
  webhooks,
  webhooksAudits,
  webhooksGuards,
} from "@/modules/webhooks/webhooks.console-resolver";
import type { Audits } from "../audit";
import type { Guards } from "../guard";
import { me, meGuards } from "./me";
import { tenants, tenantsAudits, tenantsGuards } from "./tenants";

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
