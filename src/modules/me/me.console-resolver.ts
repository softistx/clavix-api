import { callerProved, verifiedCaller } from "@/console/guard";
import type { Resolvers } from "@/generated/console/resolvers";
import { GRAPHQL_ROLE } from "@/modules/admins";
import { fail } from "@/shared/errors";
import {
  directRoles,
  memberTenants,
  operatorTenants,
} from "./me.console-support";

export { meGuards } from "./me.console-guards";
export type { MeParent } from "./me.types";

export const me: Resolvers = {
  Query: { me: () => ({}) },
  Me: {
    user: async (_, __, ctx) => {
      const user = await ctx.directory.findUser(ctx.principal.userId);
      if (user === null)
        throw fail("UNAUTHENTICATED", "No such user", { status: 401 });
      return { id: user.id, email: user.email, name: user.name ?? null };
    },
    emailVerified: (_, __, ctx) => callerProved(ctx),
    platformRole: async (_, __, ctx) => {
      const role = await ctx.access.platformRole(ctx.principal.userId);
      return role === null ? null : GRAPHQL_ROLE[role];
    },
    memberships: async (_, __, ctx) => {
      await verifiedCaller(ctx); // tenant data: behind the proof (ADR-0041)
      const roles = await ctx.access.memberships(ctx.principal.userId);
      const tenants = await ctx.directory.tenantsByIds(
        roles.map(({ tenantId }) => tenantId),
      );
      const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
      // A role on a tenant that is gone (or trashed) is not shown; a suspended one is, with its status.
      return roles.flatMap(({ tenantId, role }) => {
        const tenant = byId.get(tenantId);
        return tenant === undefined
          ? []
          : [{ tenant, role: GRAPHQL_ROLE[role] }];
      });
    },
    switchableTenants: async (_, args, ctx) => {
      await verifiedCaller(ctx); // tenant data: behind the proof (ADR-0041)
      const direct = await directRoles(ctx);
      const platform = await ctx.access.platformRole(ctx.principal.userId);
      return platform === null
        ? memberTenants(args, direct)
        : operatorTenants(args, platform, direct);
    },
  },
};
