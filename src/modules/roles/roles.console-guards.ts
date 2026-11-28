import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

// Reading roles is `view`; changing them or their holders is `edit`.
export const rolesGuards: Guards = {
  "Query.roles": view,
  "Query.role": view,
  "Query.roleMembers": view,
  "Query.userRoles": view,
  "Mutation.createRole": edit,
  "Mutation.updateRole": edit,
  "Mutation.deleteRole": edit,
  "Mutation.assignRole": edit,
  "Mutation.unassignRole": edit,
  "Mutation.setRolePermissions": edit,
};

// One event per mutation, once its change is stored; a repeat records again
// (the retry of a call whose record failed). `assignRole` and `unassignRole`
// record two, one for the role and one for the user. Ids only.
export const rolesAudits: Audits = {
  "Mutation.createRole": "role.create",
  "Mutation.updateRole": "role.update",
  "Mutation.deleteRole": "role.delete",
  "Mutation.assignRole": "role.assign",
  "Mutation.unassignRole": "role.unassign",
  "Mutation.setRolePermissions": "role.setPermissions",
};
