import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Audits } from "../audit";
import type { Guards } from "../guard";
import { admins, adminsAudits, adminsGuards } from "./admins";
import { branding, brandingAudits, brandingGuards } from "./branding";
import { clients, clientsAudits, clientsGuards } from "./clients";
import { domains, domainsAudits, domainsGuards } from "./domains";
import { me, meGuards } from "./me";
import { resources, resourcesAudits, resourcesGuards } from "./resources";
import {
  signInMethods,
  signInMethodsAudits,
  signInMethodsGuards,
} from "./sign-in-methods";
import { tenants, tenantsAudits, tenantsGuards } from "./tenants";

// One entry per module: its resolvers, the guard of each root field it adds
// and the audit action of each mutation it adds. A root field with no guard is
// denied (guard.ts); a mutation with no audit action fails audit.spec.ts.
export const resolvers: Resolvers = mergeResolvers([
  me,
  admins,
  branding,
  signInMethods,
  clients,
  domains,
  resources,
  tenants,
]);
export const guards: Guards = {
  ...meGuards,
  ...adminsGuards,
  ...brandingGuards,
  ...clientsGuards,
  ...domainsGuards,
  ...resourcesGuards,
  ...tenantsGuards,
  ...signInMethodsGuards,
};
export const audits: Audits = {
  ...adminsAudits,
  ...brandingAudits,
  ...clientsAudits,
  ...domainsAudits,
  ...resourcesAudits,
  ...tenantsAudits,
  ...signInMethodsAudits,
};
