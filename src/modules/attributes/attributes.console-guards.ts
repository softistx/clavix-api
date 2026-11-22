import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);
const manage = onTenant("manage", tenantArg);

// Reading the catalogue is `view`; changing it is `edit`. The permanent delete
// also removes every value the attribute holds, so it is `manage` (owner).
export const attributesGuards: Guards = {
  "Query.userAttributes": view,
  "Query.userAttribute": view,
  "Mutation.createUserAttribute": edit,
  "Mutation.updateUserAttribute": edit,
  "Mutation.moveUserAttribute": edit,
  "Mutation.archiveUserAttribute": edit,
  "Mutation.restoreUserAttribute": edit,
  "Mutation.deleteUserAttribute": manage,
  "Mutation.setUserAttributeValues": edit,
};

// One event per mutation, once its change is stored; a repeat records again.
// Ids only: never a label or a value.
export const attributesAudits: Audits = {
  "Mutation.createUserAttribute": "userAttribute.create",
  "Mutation.updateUserAttribute": "userAttribute.update",
  "Mutation.moveUserAttribute": "userAttribute.move",
  "Mutation.archiveUserAttribute": "userAttribute.archive",
  "Mutation.restoreUserAttribute": "userAttribute.restore",
  "Mutation.deleteUserAttribute": "userAttribute.delete",
  "Mutation.setUserAttributeValues": "user.setAttributes",
};
