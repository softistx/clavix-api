import type { TypedCollection } from "@softistx/mongo";
import type { roleAssignments, roles } from "@/modules/roles";
import type { roleAttributes, userAttributes } from "./attributes.model";

export interface RoleAttributesOptions {
  links: TypedCollection<typeof roleAttributes>;
  /** Read only: a link names a role-family attribute of the catalogue. */
  attributes: TypedCollection<typeof userAttributes>;
  /** Read only: a link names a role of the tenant. */
  roles: TypedCollection<typeof roles>;
  /** Read only: a role section is held by the users that hold the role. */
  assignments: TypedCollection<typeof roleAssignments>;
}
