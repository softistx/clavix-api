import type {
  PendingInvitation,
  TenantInvitations,
} from "@/invitations/tenant-invitations";
import { ROLES, type Role } from "../../model";
import type { AdminInvitation, ConsoleAdmins } from "./ports";

const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

const toAdminInvitation = (invitation: PendingInvitation): AdminInvitation => ({
  ...invitation,
  // Only roles of this model are ever issued; anything else reads as the weakest.
  role: isRole(invitation.role) ? invitation.role : "viewer",
});

export interface JanusAdminsOptions {
  /** The invitations of the `clavix` tenant (the console's users). */
  invitations: TenantInvitations;
  /** A user of the `clavix` tenant by e-mail, or `null`. */
  userByEmail(email: string): Promise<{ id: string } | null>;
}

/** `ConsoleAdmins` over the `clavix` tenant's invitations (scope = the managed tenant's id). */
export function createJanusAdmins({
  invitations,
  userByEmail,
}: JanusAdminsOptions): ConsoleAdmins {
  return {
    userByEmail,
    invite: async ({ tenantId, tenantName, email, role, invitedBy }) =>
      toAdminInvitation(
        await invitations.invite({
          scope: tenantId,
          organization: tenantName,
          email,
          role,
          invitedBy,
        }),
      ),
    invitations: async (tenantId) =>
      (await invitations.pending(tenantId)).map(toAdminInvitation),
    revoke: (tenantId, invitationId) =>
      invitations.revoke(tenantId, invitationId),
  };
}
