/** A pending invitation of a tenant's user pool, as a console lists it. */
export interface PendingInvitation {
  id: string;
  email: string;
  /** The role as it was issued; its meaning belongs to the caller. */
  role: string;
  invitedAt: Date;
  expiresAt: Date;
  /** The id of the user who invited, or `null` when the system did (a CLI). */
  invitedBy: string | null;
}

export interface StoredInvitation {
  id: string;
  email: string;
  role: string;
  createdAt: Date;
  /** Moves on a resend; an invitation is otherwise not written while pending. */
  updatedAt: Date;
  expiresAt: Date;
  invitedBy: string | null;
}

/** The slice of a tenant's janus instance the invitations use. */
export interface InvitationsAuth {
  invitations: {
    issue(input: {
      scope: string;
      email: string;
      name: string;
      role: string;
      invitedBy: { id: string } | null;
    }): Promise<{ code: string; invitation: StoredInvitation }>;
    list(
      scope: string,
      page: {
        status: "pending";
        lapsed: "exclude";
        limit: number;
        after: string | null;
      },
    ): Promise<{
      items: readonly StoredInvitation[];
      nextCursor: string | null;
    }>;
    get(input: {
      id: string;
      scope: string;
    }): Promise<
      (StoredInvitation & { status: "pending" | "accepted" | "revoked" }) | null
    >;
    resend(input: {
      id: string;
      scope: string;
      by?: string;
    }): Promise<{ code: string; invitation: StoredInvitation }>;
    revoke(input: { id: string; scope: string }): Promise<unknown>;
  };
}

/** Where a tenant's invitations are issued and how they are mailed. */
export interface InvitationSource {
  /** The janus instance of the tenant whose user pool the invitee joins. */
  auth: InvitationsAuth;
  /** The tenant's e-mails (janus-mail's `invitation`). */
  mail: {
    invitation(
      to: { email: string },
      data: {
        inviter?: string;
        organization: string;
        role: string;
        link: string;
        expiresAt: Date;
      },
    ): Promise<unknown>;
  };
  /** The hosted page that accepts a code (`INVITATION_PATH` on the tenant's host). */
  link(code: string): string;
}

export const toPending = (invitation: StoredInvitation): PendingInvitation => ({
  id: invitation.id,
  email: invitation.email,
  role: invitation.role,
  invitedAt: invitation.createdAt,
  expiresAt: invitation.expiresAt,
  invitedBy: invitation.invitedBy,
});
