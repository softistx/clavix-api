import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import type { TenantRole } from "../../access";
import type { ConsoleContext } from "../../context";
import { lastOwnerError, membersKey } from "../admins/service";

/**
 * The tenants where the user holds any role, sorted: a fixed lock order, so
 * two callers cannot deadlock. Every one is locked, since the delete sweeps
 * all the user's roles, not only the ownerships.
 */
const memberTenants = async (ctx: ConsoleContext, userId: string) =>
  ((await ctx.access.memberships(userId)) as TenantRole[])
    .map(({ tenantId }) => tenantId)
    .sort();

/** Ownership granted between the read of the tenants and their locks. */
class OwnershipMoved extends Error {
  constructor(readonly tenants: readonly string[]) {
    super("ownership moved");
  }
}

/** Every owner of the tenant but `userId` that can still sign in. */
async function otherLiveOwners(
  ctx: ConsoleContext,
  clavixId: string,
  tenantId: string,
  userId: string,
) {
  let live = 0;
  for (const owner of await ctx.access.owners(tenantId)) {
    if (owner === userId) continue;
    if ((await ctx.users.find(clavixId, owner))?.active === true) live++;
  }
  return live;
}

/**
 * Disabling or deleting a `clavix` user who holds a platform role or a role on
 * a tenant is a membership change: for an owner it needs `manage` on the
 * platform, not the `edit` the field asks (an admin must not remove an
 * owner). It also never orphans a tenant: when no other owner who can sign in
 * would be left on a tenant the user owns, `LAST_OWNER`.
 *
 * `work` (the disable or the delete) runs inside the members lock of every
 * tenant the user holds a role on, where the owners are counted, so a
 * concurrent change of the memberships cannot slip between the check and the
 * work; the roles are read again under the locks, and the whole step starts
 * over when one was granted meanwhile. The locks are nested (10 s TTL each,
 * see `exclusive.ts`): the guarantee holds while the whole step stays under it.
 * A user of another tenant is not an operator: `work` runs as is.
 */
export async function keepOwners<T>(
  ctx: ConsoleContext,
  tenant: { slug: string },
  tenantId: string,
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (tenant.slug !== PLATFORM_TENANT_SLUG) return work();
  const guard = async (owns: boolean) => {
    if (
      (owns || (await ctx.access.platformRole(userId)) !== null) &&
      !(await ctx.canPlatform("manage"))
    ) {
      throw denial("FORBIDDEN", "Not allowed");
    }
  };
  let held = await memberTenants(ctx, userId);
  const inside = async (): Promise<T> => {
    // Read again under the locks: a role granted since is not locked.
    const now = await ctx.access.memberships(userId);
    const ids = now.map((m) => m.tenantId).sort();
    if (ids.some((id) => !held.includes(id))) throw new OwnershipMoved(ids);
    const owned = now.filter((m) => m.role === "owner");
    // Checked again here: a user who became an owner during a retry still
    // needs `manage`.
    await guard(owned.length > 0);
    for (const { tenantId: owns } of owned) {
      if ((await otherLiveOwners(ctx, tenantId, owns, userId)) === 0) {
        throw lastOwnerError();
      }
    }
    return work();
  };
  const nest = (rest: readonly string[]): Promise<T> => {
    const [next, ...others] = rest;
    return next === undefined
      ? inside()
      : ctx.exclusive(membersKey(next), () => nest(others));
  };
  // Refused before any lock when the caller is not allowed at all.
  await guard(
    (await ctx.access.memberships(userId)).some((m) => m.role === "owner"),
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await nest(held);
    } catch (error) {
      if (!(error instanceof OwnershipMoved)) throw error;
      held = [...error.tenants];
    }
  }
  throw new GraphQLError("The memberships keep changing, try again", {
    extensions: { code: "CONFLICT", http: { status: 409 } },
  });
}
