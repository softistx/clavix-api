import { denial } from "@softistx/janus-graphql";
import type { Resolvers } from "@/generated/console/resolvers";
import { type Guards, signedIn } from "../../guard";
import type { Role } from "../../model";

const GRAPHQL_ROLE = {
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
} as const satisfies Record<Role, string>;

/** `Me` has no stored document: its fields read the caller from the context. */
export type MeParent = Record<string, never>;

export const meGuards: Guards = { "Query.me": signedIn() };

export const me: Resolvers = {
  Query: { me: () => ({}) },
  Me: {
    user: async (_, __, ctx) => {
      const user = await ctx.directory.findUser(ctx.principal.userId);
      if (user === null) throw denial("UNAUTHENTICATED", "No such user");
      return { id: user.id, email: user.email, name: user.name ?? null };
    },
    platformRole: async (_, __, ctx) => {
      const role = await ctx.access.platformRole(ctx.principal.userId);
      return role === null ? null : GRAPHQL_ROLE[role];
    },
    memberships: async (_, __, ctx) => {
      const roles = await ctx.access.memberships(ctx.principal.userId);
      const tenants = await ctx.directory.tenantsByIds(
        roles.map(({ tenantId }) => tenantId),
      );
      const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
      // A role on a tenant that is gone or suspended is not shown.
      return roles.flatMap(({ tenantId, role }) => {
        const tenant = byId.get(tenantId);
        return tenant === undefined
          ? []
          : [{ tenant, role: GRAPHQL_ROLE[role] }];
      });
    },
  },
};
