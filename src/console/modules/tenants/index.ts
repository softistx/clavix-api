import type { Resolvers } from "@/generated/console/resolvers";
import {
  effectiveQuotas,
  overridesOf,
  planOf,
} from "@/modules/tenants/plan.schema";
import { stateOf, type TenantState } from "@/modules/tenants/tenants.admin";
import { purgeAtOf } from "@/modules/tenants/trash.schema";
import { docOf } from "./lookup";
import { tenantMutations } from "./mutations";
import { quotasOut, tenantQueries } from "./queries";

export { tenantsAudits, tenantsGuards } from "./guards";
export type { TenantParent } from "./parent";

const STATUS = {
  active: "ACTIVE",
  suspended: "SUSPENDED",
  deleted: "DELETED",
} as const satisfies Record<TenantState, string>;

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
