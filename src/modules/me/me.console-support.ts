import { tenantsService } from "@/config/tenancy";
import type { ConsoleContext } from "@/console/context";
import type { Role } from "@/console/model";
import { GRAPHQL_ROLE } from "@/modules/admins/admins.utils";
import { parentOf } from "@/modules/tenants/tenants.console-parent";
import { limitOf, listing, stronger } from "./me.utils";

interface Page {
  q?: string | null | undefined;
  after?: string | null | undefined;
  first?: number | null | undefined;
}

/** An operator may work on every tenant outside the trash. */
export async function operatorTenants(
  { q, after, first }: Page,
  platform: Role,
  direct: ReadonlyMap<string, Role>,
) {
  const text = q?.trim() ?? "";
  const [page, totalCount] = await listing(() =>
    Promise.all([
      tenantsService.list({
        q: text,
        state: "live",
        after: after ?? undefined,
        first: limitOf(first),
      }),
      tenantsService.count({ q: text, state: "live" }),
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

/**
 * Everyone else: the tenants of their roles, a suspended one included (the
 * console stays readable on it), the trash left out. Paged by the database
 * like the operator's, so the cursor is the same opaque one.
 */
export async function memberTenants(
  { q, after, first }: Page,
  direct: ReadonlyMap<string, Role>,
) {
  const text = q?.trim() ?? "";
  const ids = [...direct.keys()];
  const [page, totalCount] = await listing(() =>
    Promise.all([
      tenantsService.list({
        q: text,
        state: "live",
        ids,
        after: after ?? undefined,
        first: limitOf(first),
      }),
      tenantsService.count({ q: text, state: "live", ids }),
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
}

/** The roles the caller holds directly, by tenant id. */
export async function directRoles(ctx: ConsoleContext) {
  return new Map(
    (await ctx.access.memberships(ctx.principal.userId)).map(
      ({ tenantId, role }) => [tenantId, role] as const,
    ),
  );
}
