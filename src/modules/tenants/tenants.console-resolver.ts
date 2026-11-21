import type { Resolvers } from "@/generated/console/resolvers";
import {
  effectiveQuotas,
  overridesOf,
  planOf,
  purgeAtOf,
  stateOf,
} from "@/modules/tenants";
import { tenantsAudits, tenantsGuards } from "./tenants.console-guards";
import { tenantMutations } from "./tenants.console-mutations";
import { tenantQueries } from "./tenants.console-queries";
import { docOf, quotasOut, STATUS } from "./tenants.console-support";

export type { TenantParent } from "./tenants.console-parent";
export { tenantsAudits, tenantsGuards };

export const tenants: Resolvers = {
  Tenant: {
    status: async (parent) => STATUS[stateOf(await docOf(parent)) ?? "deleted"],
    signUp: async (parent) => (await docOf(parent)).signUp,
    plan: async (parent) => planOf((await docOf(parent)).plan),
    quotaOverrides: async (parent) =>
      overridesOf((await docOf(parent)).quotaOverrides),
    quotas: async (parent) => quotasOut(effectiveQuotas(await docOf(parent))),
    createdAt: async (parent) => (await docOf(parent)).createdAt,
    deletedAt: async (parent) => (await docOf(parent)).deletedAt,
    purgeAt: async (parent) => {
      const { deletedAt } = await docOf(parent);
      return deletedAt === null ? null : purgeAtOf(deletedAt);
    },
  },
  Query: tenantQueries,
  Mutation: tenantMutations,
};
