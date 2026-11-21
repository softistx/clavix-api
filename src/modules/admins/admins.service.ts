import { denial } from "@softistx/janus-graphql";
import type { Access } from "@/console/access";
import type { ConsoleDirectory } from "@/console/context";
import type { Exclusive } from "@/console/exclusive";
import { ROLES, type Role } from "@/console/model";
import { alreadyMember, lastOwnerError } from "./admins.errors";
import { membersKey } from "./admins.utils";

/**
 * The one owner rule, for every write: an owner counts only while they exist
 * and can sign in. How many of `owners` but `userId` do; the change that
 * makes it 0 for the last one is `LAST_OWNER`.
 */
export async function otherLiveOwners(
  directory: Pick<ConsoleDirectory, "findUser">,
  owners: readonly string[],
  userId: string,
): Promise<number> {
  let live = 0;
  for (const owner of owners) {
    if (owner === userId) continue;
    if ((await directory.findUser(owner))?.active === true) live++;
  }
  return live;
}

export type AdminsAccess = Pick<
  Access,
  "holders" | "grantTenant" | "revokeTenant"
>;

/** The role a user holds directly on the tenant (the strongest), or `null`. */
export async function roleOf(
  access: Pick<Access, "holders">,
  tenantId: string,
  userId: string,
): Promise<Role | null> {
  for (const role of ROLES) {
    if ((await access.holders(tenantId, role)).includes(userId)) return role;
  }
  return null;
}

/** The tenant's members, owners first. A user who is gone is left out. */
export async function members(
  access: AdminsAccess,
  directory: ConsoleDirectory,
  tenantId: string,
) {
  const found: {
    user: NonNullable<Awaited<ReturnType<ConsoleDirectory["findUser"]>>>;
    role: Role;
  }[] = [];
  const seen = new Set<string>();
  for (const role of ROLES) {
    for (const userId of await access.holders(tenantId, role)) {
      if (seen.has(userId)) continue; // the strongest role wins
      seen.add(userId);
      const user = await directory.findUser(userId);
      if (user !== null) found.push({ user, role });
    }
  }
  return found;
}

/** The platform's operators, owners first, one entry per user (the strongest role). A user who is gone is left out. */
export async function platformOperators(
  access: Pick<Access, "platformHolders">,
  directory: Pick<ConsoleDirectory, "findUser">,
) {
  const found: {
    user: NonNullable<Awaited<ReturnType<ConsoleDirectory["findUser"]>>>;
    role: Role;
  }[] = [];
  const seen = new Set<string>();
  for (const role of ROLES) {
    for (const userId of await access.platformHolders(role)) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      const user = await directory.findUser(userId);
      if (user !== null) found.push({ user, role });
    }
  }
  return found;
}

/**
 * Gives the user exactly `role` on the tenant (the others are revoked), or
 * none, unless that leaves the tenant with no owner. The relation store has
 * no conditional write, so the check and the writes only hold together under
 * the tenant's `membersKey`: call it through `changeRole` / `removeMember`,
 * never bare.
 */
async function setRole(
  { access, directory }: Pick<MembersDeps, "access" | "directory">,
  tenantId: string,
  userId: string,
  role: Role | null,
): Promise<void> {
  const owners = await access.holders(tenantId, "owner");
  if (
    role !== "owner" &&
    owners.includes(userId) &&
    (await otherLiveOwners(directory, owners, userId)) === 0
  ) {
    throw lastOwnerError();
  }
  if (role !== null) await access.grantTenant(tenantId, userId, role);
  for (const other of ROLES) {
    if (other !== role) await access.revokeTenant(tenantId, userId, other);
  }
}

export interface MembersDeps {
  access: AdminsAccess;
  directory: Pick<ConsoleDirectory, "findUser">;
  exclusive: Exclusive;
}

/**
 * Gives a member another role, one change of the tenant's memberships at a
 * time. `NOT_FOUND` for a user who is not a member, `LAST_OWNER` when it
 * would leave no owner. Answers the role as stored.
 */
export const changeRole = (
  deps: MembersDeps,
  tenantId: string,
  userId: string,
  role: Role,
): Promise<Role> =>
  deps.exclusive(membersKey(tenantId), async () => {
    if ((await roleOf(deps.access, tenantId, userId)) === null) {
      throw denial("NOT_FOUND", "Not a member of this tenant");
    }
    await setRole(deps, tenantId, userId, role);
    return (await roleOf(deps.access, tenantId, userId)) ?? role;
  });

/** Removes a member (a non-member is left as is); `LAST_OWNER` for the last owner who can sign in. */
export const removeMember = (
  deps: MembersDeps,
  tenantId: string,
  userId: string,
): Promise<void> =>
  deps.exclusive(membersKey(tenantId), () =>
    setRole(deps, tenantId, userId, null),
  );

export async function assertNotMember(
  access: AdminsAccess,
  tenantId: string,
  userId: string,
) {
  if ((await roleOf(access, tenantId, userId)) !== null) {
    throw alreadyMember();
  }
}
