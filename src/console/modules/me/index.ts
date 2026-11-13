import { denial } from "@softistx/janus-graphql";
import { InvalidCursorError } from "@softistx/mongo";
import { GraphQLError } from "graphql";
import { tenantAdmin } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import { type Guards, signedIn } from "../../guard";
import { ROLES, type Role } from "../../model";
import { parentOf } from "../tenants/parent";

const GRAPHQL_ROLE = {
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
} as const satisfies Record<Role, string>;

/** `Me` has no stored document: its fields read the caller from the context. */
export type MeParent = Record<string, never>;

export const meGuards: Guards = { "Query.me": signedIn() };

const MAX_PAGE = 100;

const stronger = (a: Role, b: Role | null): Role =>
  b !== null && ROLES.indexOf(b) < ROLES.indexOf(a) ? b : a;

/** A page of tenants; a cursor that is not valid is the caller's mistake. */
async function listing<T>(page: () => Promise<T>): Promise<T> {
  try {
    return await page();
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw new GraphQLError("The cursor is not valid", {
        extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
      });
    }
    throw error;
  }
}

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
      // A role on a tenant that is gone (or trashed) is not shown; a suspended one is, with its status.
      return roles.flatMap(({ tenantId, role }) => {
        const tenant = byId.get(tenantId);
        return tenant === undefined
          ? []
          : [{ tenant, role: GRAPHQL_ROLE[role] }];
      });
    },
    switchableTenants: async (_, { q, after, first }, ctx) => {
      const userId = ctx.principal.userId;
      const limit = Math.min(Math.max(first ?? 25, 1), MAX_PAGE);
      const text = q?.trim() ?? "";
      const direct = new Map(
        (await ctx.access.memberships(userId)).map(
          ({ tenantId, role }) => [tenantId, role] as const,
        ),
      );
      const platform = await ctx.access.platformRole(userId);

      // An operator may work on every tenant outside the trash.
      if (platform !== null) {
        const [page, totalCount] = await listing(() =>
          Promise.all([
            tenantAdmin.list({
              q: text,
              state: "live",
              after: after ?? undefined,
              first: limit,
            }),
            tenantAdmin.count({ q: text, state: "live" }),
          ]),
        );
        return {
          items: page.items.map((tenant) => ({
            tenant: parentOf(tenant),
            role: GRAPHQL_ROLE[
              stronger(platform, direct.get(tenant._id.toHexString()) ?? null)
            ],
          })),
          nextCursor: page.nextCursor,
          totalCount,
        };
      }

      // Everyone else: the tenants of their roles, a suspended one included
      // (the console stays readable on it), the trash left out. Paged by the
      // database like the operator's, so the cursor is the same opaque one.
      const ids = [...direct.keys()];
      const [page, totalCount] = await listing(() =>
        Promise.all([
          tenantAdmin.list({
            q: text,
            state: "live",
            ids,
            after: after ?? undefined,
            first: limit,
          }),
          tenantAdmin.count({ q: text, state: "live", ids }),
        ]),
      );
      return {
        items: page.items.flatMap((tenant) => {
          const role = direct.get(tenant._id.toHexString());
          return role === undefined
            ? []
            : [{ tenant: parentOf(tenant), role: GRAPHQL_ROLE[role] }];
        }),
        nextCursor: page.nextCursor,
        totalCount,
      };
    },
  },
};
