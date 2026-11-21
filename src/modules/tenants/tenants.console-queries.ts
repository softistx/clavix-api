import { tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import type { Resolvers } from "@/generated/console/resolvers";
import { PLANS } from "@/modules/tenants";
import { isMonth } from "@/modules/usage/usage.utils";
import { badInput } from "./tenants.console-errors";
import { parentOf } from "./tenants.console-parent";
import {
  MAX_PAGE,
  notFound,
  quotasOut,
  STATE,
} from "./tenants.console-support";

export const tenantQueries: NonNullable<Resolvers["Query"]> = {
  tenants: async (_, { q, status, after, first }) => {
    const state =
      status === null || status === undefined ? undefined : STATE[status];
    const [page, totalCount] = await Promise.all([
      tenantsService.list({
        q: q ?? undefined,
        state,
        after: after ?? undefined,
        first: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
      }),
      tenantsService.count({ q: q ?? undefined, state }),
    ]);
    return {
      items: page.items.map(parentOf),
      nextCursor: page.nextCursor,
      totalCount,
    };
  },
  tenant: async (_, { id }, ctx) => {
    const tenant = await tenantsService.find(id.toLowerCase());
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
    const tenant = await tenantsService.find(tenantId.toLowerCase());
    if (
      tenant === undefined ||
      (tenant.deletedAt !== null && !(await ctx.canPlatform("view")))
    ) {
      throw notFound();
    }
    return usageService.report(tenant, month ?? undefined);
  },
};
