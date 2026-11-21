import type { ObjectId } from "mongodb";
import { unique } from "@/shared/values";
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
  return unique(names).sort();
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

/** What the console shows of a role, with its member count. */
export const shape = (role: RoleDoc, memberCount: number) => ({
  id: role._id.toHexString(),
  name: role.name,
  description: role.description === "" ? null : role.description,
  resourceId: role.resourceId?.toHexString() ?? null,
  managed: role.managed,
  memberCount,
  createdAt: role.createdAt,
});

/** What an admin event names: the role or user id and its tenant. */
export const target = (
  type: "role" | "user",
  id: string,
  tenantId: string,
) => ({
  type,
  id,
  tenantId,
});
