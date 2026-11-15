import { tenantAdmin } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import type { Resolvers } from "@/generated/console/resolvers";
import { type effectiveQuotas, PLANS } from "@/modules/tenants/plan.schema";
import type { TenantState } from "@/modules/tenants/tenants.admin";
import { isMonth } from "@/modules/usage/mau";
import { badInput } from "./errors";
import { notFound } from "./lookup";
import { parentOf } from "./parent";

const STATE = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
} as const satisfies Record<string, TenantState>;
const MAX_PAGE = 100;

export const quotasOut = (quotas: ReturnType<typeof effectiveQuotas>) => ({
  ...quotas,
});

export const tenantQueries: NonNullable<Resolvers["Query"]> = {
  tenants: async (_, { q, status, after, first }) => {
    const state =
      status === null || status === undefined ? undefined : STATE[status];
    const [page, totalCount] = await Promise.all([
      tenantAdmin.list({
        q: q ?? undefined,
        state,
        after: after ?? undefined,
        first: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
      }),
      tenantAdmin.count({ q: q ?? undefined, state }),
    ]);
    return {
      items: page.items.map(parentOf),
      nextCursor: page.nextCursor,
      totalCount,
    };
  },
  tenant: async (_, { id }, ctx) => {
    const tenant = await tenantAdmin.find(id.toLowerCase());
    if (tenant === undefined) return null;
    // The trash is for platform operators.
    if (tenant.deletedAt !== null && !(await ctx.canPlatform("view"))) {
      return null;
    }
    return parentOf(tenant);
  },
  plans: () =>
    PLANS.map((plan) => ({ ...plan, quotas: quotasOut(plan.quotas) })),
  usage: async (_, { tenantId, month }, ctx) => {
    if (month !== null && month !== undefined && !isMonth(month)) {
      throw badInput("month must be YYYY-MM", "month");
    }
    const tenant = await tenantAdmin.find(tenantId.toLowerCase());
    if (
      tenant === undefined ||
      (tenant.deletedAt !== null && !(await ctx.canPlatform("view")))
    ) {
      throw notFound();
    }
    return usageService.report(tenant, month ?? undefined);
  },
};
