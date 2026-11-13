import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import type { Access } from "../../access";
import type { ConsoleDirectory } from "../../context";
import type { Exclusive } from "../../exclusive";
import { ROLES, type Role } from "../../model";

const conflict = (code: "LAST_OWNER" | "ALREADY_MEMBER", message: string) =>
  new GraphQLError(message, { extensions: { code, http: { status: 409 } } });

export type AdminsAccess = Pick<
  Access,
  "holders" | "grantTenant" | "revokeTenant"
>;

/** The `Exclusive` key of a tenant's memberships: every write of them runs under it. */
export const membersKey = (tenantId: string) => `console:members:${tenantId}`;

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

/** The tenant when it exists and is active, else a 404. */
export async function activeTenant(directory: ConsoleDirectory, id: string) {
  const [tenant] = await directory.tenantsByIds([id]);
  if (tenant === undefined) throw denial("NOT_FOUND", "No such tenant");
  return tenant;
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

/**
 * Gives the user exactly `role` on the tenant (the others are revoked), or
 * none, unless that leaves the tenant with no owner. The relation store has
 * no conditional write, so the check and the writes only hold together under
 * the tenant's `membersKey`: call it through `changeRole` / `removeMember`,
 * never bare.
 */
async function setRole(
  access: AdminsAccess,
  tenantId: string,
  userId: string,
  role: Role | null,
): Promise<void> {
  const owners = await access.holders(tenantId, "owner");
  if (role !== "owner" && owners.length === 1 && owners[0] === userId) {
    throw conflict("LAST_OWNER", "A tenant keeps at least one owner");
  }
  if (role !== null) await access.grantTenant(tenantId, userId, role);
  for (const other of ROLES) {
    if (other !== role) await access.revokeTenant(tenantId, userId, other);
  }
}

export interface MembersDeps {
  access: AdminsAccess;
  exclusive: Exclusive;
}

/**
 * Gives a member another role, one change of the tenant's memberships at a
 * time. `NOT_FOUND` for a user who is not a member, `LAST_OWNER` when it
 * would leave no owner. Answers the role as stored.
 */
export const changeRole = (
  { access, exclusive }: MembersDeps,
  tenantId: string,
  userId: string,
  role: Role,
): Promise<Role> =>
  exclusive(membersKey(tenantId), async () => {
    if ((await roleOf(access, tenantId, userId)) === null) {
      throw denial("NOT_FOUND", "Not a member of this tenant");
    }
    await setRole(access, tenantId, userId, role);
    return (await roleOf(access, tenantId, userId)) ?? role;
  });

/** Removes a member (a non-member is left as is); `LAST_OWNER` for the last owner. */
export const removeMember = (
  { access, exclusive }: MembersDeps,
  tenantId: string,
  userId: string,
): Promise<void> =>
  exclusive(membersKey(tenantId), () =>
    setRole(access, tenantId, userId, null),
  );

export async function assertNotMember(
  access: AdminsAccess,
  tenantId: string,
  userId: string,
) {
  if ((await roleOf(access, tenantId, userId)) !== null) {
    throw conflict("ALREADY_MEMBER", "Already an admin of this tenant");
  }
}
