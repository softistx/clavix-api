import type { ObjectId } from "mongodb";
import type { RoleDoc } from "./roles.types";

/** A copy of the roles sorted by name. */
export function sortedByName(found: readonly RoleDoc[]): RoleDoc[] {
  return [...found].sort((a, b) => a.name.localeCompare(b.name));
}

/** The roles whose id is in `ids` (hex), sorted by name. */
export function heldRoles(
  all: readonly RoleDoc[],
  ids: ReadonlySet<string>,
): RoleDoc[] {
  return sortedByName(all.filter((role) => ids.has(role._id.toHexString())));
}

/**
 * The names of the held roles that apply to a token: the tenant-wide ones plus
 * those scoped to `resourceId` (hex, `null` for no resource). Sorted, one per name.
 */
export function claimNames(
  held: readonly RoleDoc[],
  resourceId: string | null,
): string[] {
  const names = held
    .filter(
      (role) =>
        role.resourceId === null ||
        role.resourceId.toHexString() === resourceId,
    )
    .map((role) => role.name);
  return [...new Set(names)].sort();
}

/** Each role's id (hex) at 0, then the grouped counts of the roles that have holders. */
export function countsByRole(
  found: readonly RoleDoc[],
  grouped: readonly { _id: ObjectId; n: number }[],
): Map<string, number> {
  const counts = new Map(found.map((role) => [role._id.toHexString(), 0]));
  for (const { _id, n } of grouped) counts.set(_id.toHexString(), n);
  return counts;
}
