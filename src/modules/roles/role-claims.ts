import { scopeToTenant } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { AssignmentDoc, RoleDoc, RolesOptions } from "./roles.service";

export type { AssignmentDoc, RoleDoc };

/** The roles a user holds, by name. */
export async function rolesOfUser(
  options: RolesOptions,
  tenantId: ObjectId,
  userId: string,
): Promise<RoleDoc[]> {
  const held = await scopeToTenant(options.assignments, tenantId).findMany({
    filter: { userId },
  });
  if (held.length === 0) return [];
  const ids = new Set(held.map((a) => a.roleId.toHexString()));
  const all = await scopeToTenant(options.roles, tenantId).findMany();
  return all
    .filter((role) => ids.has(role._id.toHexString()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The `roles` claim: tenant-wide roles plus those of the audience's resource; sorted, one per name. */
export async function claimRoles(
  options: RolesOptions,
  tenantId: ObjectId,
  userId: string,
  audience: string | null,
): Promise<string[]> {
  const held = await rolesOfUser(options, tenantId, userId);
  if (held.length === 0) return [];
  let resourceId: string | null = null;
  if (audience !== null) {
    const resource = await scopeToTenant(options.resources, tenantId).findFirst(
      { uri: audience },
    );
    resourceId = resource?._id.toHexString() ?? null;
  }
  const names = held
    .filter(
      (role) =>
        role.resourceId === null ||
        role.resourceId.toHexString() === resourceId,
    )
    .map((role) => role.name);
  return [...new Set(names)].sort();
}
