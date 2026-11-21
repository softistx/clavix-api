import type { PendingInvitation, StoredInvitation } from "./invitations.types";

/** A janus invitation as a console lists it. */
export const toPending = (invitation: StoredInvitation): PendingInvitation => ({
  id: invitation.id,
  email: invitation.email,
  role: invitation.role,
  invitedAt: invitation.createdAt,
  expiresAt: invitation.expiresAt,
  invitedBy: invitation.invitedBy,
});
