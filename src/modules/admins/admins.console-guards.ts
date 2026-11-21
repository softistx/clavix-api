import type { Audits } from "@/console/audit";
import { type Guards, onPlatform, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

// Reading the admins is `view`; changing them is `manage` (the tenant's owner,
// or a platform owner): an admin or a viewer cannot grant roles.
export const adminsGuards: Guards = {
  "Query.memberships": onTenant("view", tenantArg),
  "Query.platformOperators": onPlatform("view"),
  "Query.adminInvitations": onTenant("view", tenantArg),
  "Mutation.inviteAdmin": onTenant("manage", tenantArg),
  "Mutation.changeMembership": onTenant("manage", tenantArg),
  "Mutation.removeMembership": onTenant("manage", tenantArg),
  "Mutation.revokeAdminInvitation": onTenant("manage", tenantArg),
  "Mutation.resendAdminInvitation": onTenant("manage", tenantArg),
};

// One event per mutation, recorded once its change is stored. A repeat records
// again (a removal of a non-member, a revocation of nothing): the retry of a
// call whose record failed must not leave the change with no event.
export const adminsAudits: Audits = {
  "Mutation.inviteAdmin": "membership.invite",
  "Mutation.changeMembership": "membership.change",
  "Mutation.removeMembership": "membership.remove",
  "Mutation.revokeAdminInvitation": "membership.revokeInvitation",
  "Mutation.resendAdminInvitation": "membership.resendInvitation",
};
