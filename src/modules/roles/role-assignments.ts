import { ConflictError, type Scoped } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { MAX_ID, refuse } from "./roles.input";
import type { roleAssignments } from "./roles.model";
import type { AssignmentDoc, RoleDoc } from "./roles.service";

type OwnAssignments = Scoped<typeof roleAssignments>;

/**
 * Gives the user the role. Idempotent. The caller checked the user exists in
 * the tenant's pool. `NOT_FOUND` for an unknown role; `findRole` reads a role
 * of the same tenant by its id (hex).
 */
export async function assign(
  own: OwnAssignments,
  findRole: (roleId: string) => Promise<RoleDoc | undefined>,
  roleId: string,
  userId: string,
): Promise<void> {
  const role = await findRole(roleId);
  if (role === undefined) return refuse("NOT_FOUND", "No such role");
  if (userId.length === 0 || userId.length > MAX_ID) {
    refuse("BAD_USER_INPUT", "userId is not an id");
  }
  try {
    await own.create({ roleId: role._id, userId });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
  }
  // The role may have been deleted between the check and the write: leave
  // no assignment to a role that is gone.
  if ((await findRole(roleId)) === undefined) {
    await own.hardDeleteMany({ roleId: role._id });
    refuse("NOT_FOUND", "No such role");
  }
}

/** `true` when the user held the role. */
export async function unassign(
  own: OwnAssignments,
  roleId: string,
  userId: string,
): Promise<boolean> {
  if (!ObjectId.isValid(roleId)) return false;
  return (
    (await own.hardDeleteMany({ roleId: new ObjectId(roleId), userId })) > 0
  );
}

/** Removes every assignment of a deleted user. */
export function removeUser(
  own: OwnAssignments,
  userId: string,
): Promise<number> {
  return own.hardDeleteMany({ userId });
}

/** One page of a role's assignments, oldest first. */
export async function members(
  own: OwnAssignments,
  roleId: string,
  page: { after: string | null; limit: number },
): Promise<{ items: AssignmentDoc[]; nextCursor: string | null }> {
  if (!ObjectId.isValid(roleId)) return { items: [], nextCursor: null };
  return own.paginateByCursor({
    filter: { roleId: new ObjectId(roleId) },
    after: page.after,
    limit: page.limit,
  });
}
