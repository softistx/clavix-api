import { scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { RolesService } from "@/modules/roles";
import type { PermissionsFor, RolesFor } from "@/oauth/ports";
import { roleAttributesService } from "./attributes";
import { mongo } from "./db";

/** The real roles store. The collections are tenant-owned: only this wiring and its module reach them. */
export const rolesService = new RolesService({
  roles: mongo.db.roles,
  assignments: mongo.db.roleAssignments,
  resources: mongo.db.resources,
  roleLinks: roleAttributesService,
  // Read from the collection, not through the resources service: config/resources
  // binds the roles back (the cascade of a dropped scope), so this would close a cycle.
  scopes: {
    find: async (tenantId, ids) =>
      ids.length === 0
        ? []
        : scopeToTenant(mongo.db.scopes, tenantId).findMany({
            filter: { _id: { $in: [...ids] } },
          }),
  },
});

/** The real `RolesFor`: the `roles` claim of the tokens. */
export const rolesFor: RolesFor = (tenant) => (userId, audience) =>
  rolesService.claimRoles(new ObjectId(tenant.tenantId), userId, audience);

/** The real `PermissionsFor`: the `roles` and `permissions` claims of the tokens of a resource that enforces RBAC. */
export const permissionsFor: PermissionsFor = (tenant) => (userId, audience) =>
  rolesService.claimAccess(new ObjectId(tenant.tenantId), userId, audience);
