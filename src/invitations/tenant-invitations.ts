import { JanusError } from "@softistx/janus";

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

interface StoredInvitation {
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

export interface ResendInput {
  scope: string;
  invitationId: string;
  organization: string;
  /** Who resends; named in the e-mail and kept by janus as `resentBy`. */
  by: { id: string; name?: string | undefined };
}

/** Why an invitation was not sent again. */
export type ResendRefusal =
  | "NOT_FOUND"
  | "INVITATION_NOT_PENDING"
  | "RESEND_TOO_SOON";

/** `resend` refused: nothing was renewed and no mail went out. */
export class ResendRefusedError extends Error {
  constructor(
    readonly code: ResendRefusal,
    /** `RESEND_TOO_SOON` only: whole seconds until it may be sent again. */
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = "ResendRefusedError";
  }
}

/** The least time between two sends of one invitation. */
export const RESEND_COOLDOWN_MS = 60_000;

export interface InvitationsOptions {
  /** The clock; tests move it. */
  now?: () => number;
  cooldownMs?: number;
}

/** The invitations of one tenant's user pool: issue and mail, resend, list, revoke. */
export interface TenantInvitations {
  /** Issues the invitation (a pending one of the same scope and address is replaced) and mails its link. */
  invite(input: InviteInput): Promise<PendingInvitation>;
  /**
   * Sends a pending invitation again — lapsed or not — with a new code and a
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

const toPending = (invitation: StoredInvitation): PendingInvitation => ({
  id: invitation.id,
  email: invitation.email,
  role: invitation.role,
  invitedAt: invitation.createdAt,
  expiresAt: invitation.expiresAt,
  invitedBy: invitation.invitedBy,
});

/** The tenant is missing or suspended: the call did nothing. */
export class TenantUnavailableError extends Error {
  constructor() {
    super("the tenant is not available");
    this.name = "TenantUnavailableError";
  }
}

/**
 * `TenantInvitations` over a tenant's janus invitations. `source` is read on
 * every call (a tenant's instance is rebuilt when the tenant changes); `null`
 * means the tenant is missing or suspended, and every call throws.
 */
export function createTenantInvitations(
  source: () => Promise<InvitationSource | null>,
  { now = Date.now, cooldownMs = RESEND_COOLDOWN_MS }: InvitationsOptions = {},
): TenantInvitations {
  const need = async () => {
    const found = await source();
    if (found === null) throw new TenantUnavailableError();
    return found;
  };
  return {
    async invite({ scope, organization, email, role, invitedBy }) {
      const { auth, mail, link } = await need();
      const issued = await auth.invitations.issue({
        scope,
        email,
        name: email.split("@")[0] ?? email,
        role,
        invitedBy: invitedBy === null ? null : { id: invitedBy.id },
      });
      await mail.invitation(
        { email },
        {
          ...(invitedBy?.name === undefined ? {} : { inviter: invitedBy.name }),
          organization,
          role,
          link: link(issued.code),
          expiresAt: issued.invitation.expiresAt,
        },
      );
      return toPending(issued.invitation);
    },
    async resend({ scope, invitationId, organization, by }) {
      const { auth, mail, link } = await need();
      const found = await auth.invitations.get({ id: invitationId, scope });
      if (found === null) throw new ResendRefusedError("NOT_FOUND");
      if (found.status !== "pending") {
        throw new ResendRefusedError("INVITATION_NOT_PENDING");
      }
      const wait = found.updatedAt.getTime() + cooldownMs - now();
      if (wait > 0) {
        throw new ResendRefusedError("RESEND_TOO_SOON", Math.ceil(wait / 1000));
      }
      let sent: Awaited<ReturnType<typeof auth.invitations.resend>>;
      try {
        sent = await auth.invitations.resend({
          id: invitationId,
          scope,
          by: by.id,
        });
      } catch (error) {
        // Accepted or revoked between the read and the write.
        if (error instanceof JanusError && error.code === "NOT_FOUND") {
          throw new ResendRefusedError("NOT_FOUND");
        }
        if (
          error instanceof JanusError &&
          error.code === "INVITATION_NOT_PENDING"
        ) {
          throw new ResendRefusedError("INVITATION_NOT_PENDING");
        }
        throw error;
      }
      await mail.invitation(
        { email: sent.invitation.email },
        {
          ...(by.name === undefined ? {} : { inviter: by.name }),
          organization,
          role: sent.invitation.role,
          link: link(sent.code),
          expiresAt: sent.invitation.expiresAt,
        },
      );
      return toPending(sent.invitation);
    },
    async pending(scope) {
      const { auth } = await need();
      const found: PendingInvitation[] = [];
      let after: string | null = null;
      do {
        const page = await auth.invitations.list(scope, {
          status: "pending",
          lapsed: "exclude",
          limit: 100,
          after,
        });
        found.push(...page.items.map(toPending));
        after = page.nextCursor;
      } while (after !== null);
      return found;
    },
    async revoke(scope, invitationId) {
      const { auth } = await need();
      try {
        await auth.invitations.revoke({ id: invitationId, scope });
        return true;
      } catch (error) {
        // Not this scope's, or no longer pending: nothing to revoke.
        if (
          error instanceof JanusError &&
          (error.code === "NOT_FOUND" ||
            error.code === "INVITATION_NOT_PENDING")
        ) {
          return false;
        }
        throw error;
      }
    },
  };
}
