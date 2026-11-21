import type { TenantJanus } from "@/modules/users/tenant-janus";

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

export interface ResendInput {
  scope: string;
  invitationId: string;
  organization: string;
  /** Who resends; named in the e-mail and kept by janus as `resentBy`. */
  by: { id: string; name?: string | undefined };
}

export interface InviteInput {
  /** What the invitation is for; an invitation is only listed or revoked under its scope. */
  scope: string;
  /** The name the e-mail gives to what the invitee joins. */
  organization: string;
  email: string;
  role: string;
  /** Who invites; `null` for the system (a CLI), which names no inviter in the e-mail. */
  invitedBy: { id: string; name?: string | undefined } | null;
}

export interface InvitationsOptions {
  /** The clock; tests move it. */
  now?: () => number;
  /** Least time before a pending invitation of an address is replaced or resent (60 s). */
  cooldownMs?: number;
  /** Most pending invitations per scope (500); a new address past it is refused. */
  maxPending?: number;
}

/** The invitations of one tenant's user pool: issue and mail, resend, list, revoke. */
export interface TenantInvitations {
  /**
   * Issues the invitation (a pending one of the same scope and address is
   * replaced) and mails its link. Throws `ResendRefusedError`:
   * `INVITE_TOO_SOON` (the address's pending invitation is younger than the
   * cooldown) or `PENDING_INVITATIONS_LIMIT` (the scope holds `maxPending`).
   * Not atomic: concurrent invites may pass both checks.
   */
  invite(input: InviteInput): Promise<PendingInvitation>;
  /**
   * Sends a pending invitation again, lapsed or not, with a new code and a
   * new lifetime (the old code stops working), and mails the new link. Throws
   * `ResendRefusedError`: `NOT_FOUND` (not this scope's), `INVITATION_NOT_PENDING`
   * (accepted or revoked), `RESEND_TOO_SOON` (sent, or sent again, less than
   * the cooldown ago). The check and the write are not atomic: serialise the
   * calls for one invitation.
   */
  resend(input: ResendInput): Promise<PendingInvitation>;
  /** The pending, unlapsed invitations of the scope, all of them. */
  pending(scope: string): Promise<PendingInvitation[]>;
  /** Revokes a pending invitation of the scope; `false` when it is not one. */
  revoke(scope: string, invitationId: string): Promise<boolean>;
}

/** What the hosted invitation pages read: a tenant's janus, the tenants and the usage counter. */
export interface InvitationsPorts {
  /** The janus instance of the request's host (`null` when the host is no tenant). */
  issuers: { forRequest(request: Request): Promise<TenantJanus | null> };
  tenants: {
    activeByIds(ids: readonly string[]): Promise<{ name: string }[]>;
  };
  usage: { recordActive(tenantId: string, userId: string): Promise<void> };
}
