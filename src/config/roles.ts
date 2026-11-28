import { ObjectId } from "mongodb";
import { RolesService } from "@/modules/roles";
import type { PermissionsFor, RolesFor } from "@/oauth/ports";
import { roleAttributesService } from "./attributes";
import { mongo } from "./db";
import { resourcesService } from "./resources";

/** The real roles store. The collections are tenant-owned: only this wiring and its module reach them. */
export const rolesService = new RolesService({
  roles: mongo.db.roles,
  assignments: mongo.db.roleAssignments,
  resources: mongo.db.resources,
  roleLinks: roleAttributesService,
  // Lazy: config/resources binds the roles back (the cascade of a dropped scope).
  scopes: {
    find: (tenantId, ids) => resourcesService.findScopes(tenantId, ids),
  },
});

/** The real `RolesFor`: the `roles` claim of the tokens. */
export const rolesFor: RolesFor = (tenant) => (userId, audience) =>
  rolesService.claimRoles(new ObjectId(tenant.tenantId), userId, audience);

/** The real `PermissionsFor`: the `roles` and `permissions` claims of the tokens of a resource that enforces RBAC. */
export const permissionsFor: PermissionsFor = (tenant) => (userId, audience) =>
  rolesService.claimAccess(new ObjectId(tenant.tenantId), userId, audience);
