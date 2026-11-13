import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import type { ConsoleContext } from "../../context";
import { membersKey } from "../admins/service";

const lastOwner = () =>
  new GraphQLError("A tenant keeps at least one owner", {
    extensions: { code: "LAST_OWNER", http: { status: 409 } },
  });

/** The tenants the user owns, sorted: a fixed lock order, so two callers cannot deadlock. */
const ownedTenants = async (ctx: ConsoleContext, userId: string) =>
  (await ctx.access.memberships(userId))
    .filter(({ role }) => role === "owner")
    .map(({ tenantId }) => tenantId)
    .sort();

/** Ownership granted between the read of the tenants and their locks. */
class OwnershipMoved extends Error {
  constructor(readonly tenants: readonly string[]) {
    super("ownership moved");
  }
}

/**
 * Disabling or deleting a `clavix` user who holds a platform role or owns a
 * tenant is a membership change: it needs `manage` on the platform, not the
 * `edit` the field asks (an admin must not remove an owner). It also never
 * orphans a tenant: when the user is the only owner of one, `LAST_OWNER`.
 *
 * `work` (the disable or the delete) runs inside the members lock of every
 * tenant the user owns, where the owners are counted, so a concurrent change
 * of the memberships cannot slip between the check and the work. A user of
 * another tenant is not an operator: `work` runs as is.
 */
export async function keepOwners<T>(
  ctx: ConsoleContext,
  tenant: { slug: string },
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (tenant.slug !== PLATFORM_TENANT_SLUG) return work();
  let owned = await ownedTenants(ctx, userId);
  if (
    (owned.length > 0 || (await ctx.access.platformRole(userId)) !== null) &&
    !(await ctx.canPlatform("manage"))
  ) {
    throw denial("FORBIDDEN", "Not allowed");
  }
  const inside = async (held: readonly string[]): Promise<T> => {
    // Read again under the locks: an ownership granted since is not locked.
    const now = await ownedTenants(ctx, userId);
    if (now.some((id) => !held.includes(id))) throw new OwnershipMoved(now);
    for (const tenantId of now) {
      const owners = await ctx.access.owners(tenantId);
      if (owners.length === 1 && owners[0] === userId) throw lastOwner();
    }
    return work();
  };
  const nest = (
    held: readonly string[],
    rest: readonly string[],
  ): Promise<T> => {
    const [next, ...others] = rest;
    return next === undefined
      ? inside(held)
      : ctx.exclusive(membersKey(next), () => nest(held, others));
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await nest(owned, owned);
    } catch (error) {
      if (!(error instanceof OwnershipMoved)) throw error;
      owned = [...error.tenants];
    }
  }
  throw new GraphQLError("The memberships keep changing, try again", {
    extensions: { code: "CONFLICT", http: { status: 409 } },
  });
}
