import { denial } from "@softistx/janus-graphql";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { fail } from "@/shared/errors";
import type { ConsoleContext } from "../../context";
import {
  lastOwnerError,
  membersKey,
  otherLiveOwners,
  PLATFORM_OWNERS_KEY,
} from "../admins/service";

/**
 * The tenants where the user holds any role, sorted: a fixed lock order, so
 * two callers cannot deadlock. Every one is locked, since the delete sweeps
 * all the user's roles, not only the ownerships.
 */
const memberTenants = async (ctx: ConsoleContext, userId: string) =>
  (await ctx.access.memberships(userId)).map(({ tenantId }) => tenantId).sort();

/** Ownership granted between the read of the tenants and their locks. */
class OwnershipMoved extends Error {
  constructor(readonly tenants: readonly string[]) {
    super("ownership moved");
  }
}

/**
 * What a write does to its target, for the owner rule: `disable`, `delete`
 * and `unverify` take the account out of the console (an unproved e-mail is
 * refused everywhere, ADR-0041), so they also count the owners left; `touch`
 * (enable, sign out, reset the second factor, mark the e-mail proved) only
 * needs the right caller.
 */
export type OwnerChange = "disable" | "delete" | "unverify" | "touch";

/**
 * Changing the account of a `clavix` user who holds a platform role or a role on
 * a tenant is a membership change: for an owner it needs `manage` on the
 * platform, not the `edit` the field asks (an admin must not remove, lock out
 * or weaken an owner, nor bring back one an owner disabled). Every `kind` is
 * held to it. `disable`, `delete` and `unverify` also never orphan a tenant:
 * when no other owner who can sign in
 * would be left on a tenant the user owns, or on the platform when the user
 * is a platform owner, `LAST_OWNER` (the one owner rule, `otherLiveOwners`).
 * Disabling a user who is already disabled, or un-verifying one who is
 * already unproved, changes nothing, so it is never refused.
 *
 * `work` (the change) runs inside the platform owners lock and
 * the members lock of every tenant the user holds a role on, where the owners are counted, so a
 * concurrent change of the memberships cannot slip between the check and the
 * work; the roles are read again under the locks, and the whole step starts
 * over when one was granted meanwhile. The locks are nested (10 s TTL each,
 * see `exclusive.ts`): the guarantee holds while the whole step stays under it.
 * `work` and the last read of the roles run inside the user's own lock
 * (`userLock`, `userKey`), the innermost one: a role granted to the user
 * (under that lock) cannot land between the read and the work. A user of
 * another tenant is not an operator: only the user lock is taken.
 */
export async function keepOwners<T>(
  ctx: ConsoleContext,
  tenant: { slug: string },
  userId: string,
  work: () => Promise<T>,
  kind: OwnerChange,
  userLock: string,
): Promise<T> {
  if (tenant.slug !== PLATFORM_TENANT_SLUG) {
    return ctx.exclusive(userLock, work);
  }
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
    // Nothing is lost: the change keeps every owner (`touch`), or the user
    // already does not count (disabled twice, un-verified twice).
    const already =
      kind === "touch" ||
      (kind === "disable" &&
        (await ctx.directory.findUser(userId))?.active !== true) ||
      (kind === "unverify" && !(await ctx.directory.emailVerified(userId)));
    if (!already) {
      for (const { tenantId: owns } of owned) {
        const owners = await ctx.access.owners(owns);
        if ((await otherLiveOwners(ctx.directory, owners, userId)) === 0) {
          throw lastOwnerError();
        }
      }
      if ((await ctx.access.platformRole(userId)) === "owner") {
        const owners = await ctx.access.platformOwners();
        if ((await otherLiveOwners(ctx.directory, owners, userId)) === 0) {
          throw lastOwnerError("platform");
        }
      }
    }
    return work();
  };
  // The user lock is the innermost one: members, then the user.
  const underUser = () => ctx.exclusive(userLock, inside);
  const nest = (rest: readonly string[]): Promise<T> => {
    const [next, ...others] = rest;
    return next === undefined
      ? underUser()
      : ctx.exclusive(membersKey(next), () => nest(others));
  };
  // The platform owners lock comes first, always: a fixed order.
  const locked = () => ctx.exclusive(PLATFORM_OWNERS_KEY, () => nest(held));
  // Refused before any lock when the caller is not allowed at all.
  await guard(
    (await ctx.access.memberships(userId)).some((m) => m.role === "owner"),
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await locked();
    } catch (error) {
      if (!(error instanceof OwnershipMoved)) throw error;
      held = [...error.tenants];
    }
  }
  throw fail("CONFLICT", "The memberships keep changing, try again", {
    status: 409,
  });
}
