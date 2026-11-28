import type { ObjectId } from "mongodb";
import { unique } from "@/shared/values";
import type { RoleDoc, ScopeRef, TenantRoleParent } from "./roles.types";

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

/** The scopes of a loader's answers, those found, sorted by name. */
export function permissionsOf<T extends { name: string }>(
  loaded: readonly (T | null | Error)[],
): T[] {
  const found = loaded.filter(
    (scope): scope is T => scope !== null && !(scope instanceof Error),
  );
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The scopes the held roles grant on one resource: the permissions of the
 * tenant-wide roles and of those scoped to `resourceId`, one id each.
 */
export function permissionIdsOf(
  held: readonly RoleDoc[],
  resourceId: ObjectId,
): ObjectId[] {
  const byHex = new Map<string, ObjectId>();
  for (const role of held) {
    if (role.resourceId !== null && !role.resourceId.equals(resourceId)) {
      continue;
    }
    for (const id of role.permissionIds) byHex.set(id.toHexString(), id);
  }
  return [...byHex.values()];
}

/** The names of the scopes that belong to `resourceId`, sorted, one per name. */
export function scopeNamesOf(
  scopes: readonly ScopeRef[],
  resourceId: ObjectId,
): string[] {
  const names = scopes
    .filter((scope) => scope.resourceId?.equals(resourceId) === true)
    .map((scope) => scope.name);
  return unique(names).sort();
}

/** Whether two lists hold the same ids, in any order. */
export function sameIds(
  a: readonly ObjectId[],
  b: readonly ObjectId[],
): boolean {
  const held = new Set(a.map((id) => id.toHexString()));
  return held.size === b.length && b.every((id) => held.has(id.toHexString()));
}

/** What the console shows of a role, with its member count. */
export const shape = (
  role: RoleDoc,
  memberCount: number,
): TenantRoleParent => ({
  id: role._id.toHexString(),
  name: role.name,
  description: role.description === "" ? null : role.description,
  resourceId: role.resourceId?.toHexString() ?? null,
  managed: role.managed,
  memberCount,
  createdAt: role.createdAt,
  tenantId: role.tenantId.toHexString(),
  permissionIds: role.permissionIds.map((scopeId) => scopeId.toHexString()),
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
