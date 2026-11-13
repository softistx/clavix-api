import { ObjectId } from "mongodb";
import { RolesService } from "@/modules/roles/roles.service";
import type { RolesFor } from "@/oauth/ports";
import { mongo } from "./db";

/** The real roles store. The collections are tenant-owned: only this wiring and its module reach them. */
export const rolesService = new RolesService({
  roles: mongo.db.roles,
  assignments: mongo.db.roleAssignments,
  resources: mongo.db.resources,
});

/** The real `RolesFor`: the `roles` claim of the tokens. */
export const rolesFor: RolesFor = (tenant) => (userId, audience) =>
  rolesService.claimRoles(new ObjectId(tenant.tenantId), userId, audience);
