import { adminScope } from "@/invitations/scope";
import type {
  PendingInvitation,
  TenantInvitations,
} from "@/invitations/tenant-invitations";
import type { AdminInvitation, ConsoleAdmins } from "../../context";
import { isRole } from "../../model";

const toAdminInvitation = (invitation: PendingInvitation): AdminInvitation => ({
  ...invitation,
  // Only roles of this model are ever issued; anything else reads as the weakest.
  role: isRole(invitation.role) ? invitation.role : "viewer",
});

/**
 * `ConsoleAdmins` over the invitations of the `clavix` tenant (the console's
 * users), under the managed tenant's admin scope (`adminScope`).
 */
export function createJanusAdmins(
  invitations: TenantInvitations,
): ConsoleAdmins {
  return {
    invite: async ({ tenantId, tenantName, email, role, invitedBy }) =>
      toAdminInvitation(
        await invitations.invite({
          scope: adminScope(tenantId),
          organization: tenantName,
          email,
          role,
          invitedBy,
        }),
      ),
    invitations: async (tenantId) =>
      (await invitations.pending(adminScope(tenantId))).map(toAdminInvitation),
    resend: async ({ tenantId, tenantName, invitationId, by }) =>
      toAdminInvitation(
        await invitations.resend({
          scope: adminScope(tenantId),
          invitationId,
          organization: tenantName,
          by,
        }),
      ),
    revoke: (tenantId, invitationId) =>
      invitations.revoke(adminScope(tenantId), invitationId),
  };
}
