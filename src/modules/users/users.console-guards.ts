import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

// Reading the users is `view`; changing them is `edit` (a tenant admin).
export const usersGuards: Guards = {
  "Query.users": onTenant("view", tenantArg),
  // A picker for assigning roles: the permission that assigns them.
  "Query.userLookup": onTenant("edit", tenantArg),
  "Query.user": onTenant("view", tenantArg),
  "Query.userInvitations": onTenant("view", tenantArg),
  "Query.userGrants": onTenant("view", tenantArg),
  // A user's sessions: read is `view`, ending one is `edit`.
  "Query.userSessions": onTenant("view", tenantArg),
  // The whole personal record of a user (a GDPR access request): `edit`.
  "Query.userDataExport": onTenant("edit", tenantArg),
  "Mutation.revokeUserSession": onTenant("edit", tenantArg),
  "Mutation.inviteUser": onTenant("edit", tenantArg),
  "Mutation.revokeInvitation": onTenant("edit", tenantArg),
  "Mutation.updateUser": onTenant("edit", tenantArg),
  "Mutation.disableUser": onTenant("edit", tenantArg),
  "Mutation.enableUser": onTenant("edit", tenantArg),
  "Mutation.deleteUser": onTenant("edit", tenantArg),
  "Mutation.revokeUserSessions": onTenant("edit", tenantArg),
  "Mutation.setUserEmailVerified": onTenant("edit", tenantArg),
  "Mutation.setUserPhoneVerified": onTenant("edit", tenantArg),
  "Mutation.resetUserSecondFactor": onTenant("edit", tenantArg),
  "Mutation.revokeGrant": onTenant("edit", tenantArg),
};

// One event per mutation, recorded once its change is stored. A repeat records
// again: the retry of a call whose record failed must not leave the change
// with no event. Targets are ids, never an address.
export const usersAudits: Audits = {
  "Mutation.inviteUser": "user.invite",
  "Mutation.revokeInvitation": "user.revokeInvitation",
  "Mutation.updateUser": "user.update",
  "Mutation.disableUser": "user.disable",
  "Mutation.enableUser": "user.enable",
  "Mutation.deleteUser": "user.delete",
  "Mutation.revokeUserSessions": "user.revokeSessions",
  "Mutation.setUserEmailVerified": "user.setEmailVerified",
  "Mutation.setUserPhoneVerified": "user.setPhoneVerified",
  "Mutation.resetUserSecondFactor": "user.resetSecondFactor",
  "Mutation.revokeGrant": "user.revokeGrant",
  "Mutation.revokeUserSession": "user.revokeSession",
};
