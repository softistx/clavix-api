import { JanusError } from "@softistx/janus";

/** A pending invitation of a tenant's user pool, as a console lists it. */
export interface PendingInvitation {
  id: string;
  email: string;
  /** The role as it was issued; its meaning belongs to the caller. */
  role: string;
  invitedAt: Date;
  expiresAt: Date;
}

interface StoredInvitation {
  id: string;
  email: string;
  role: string;
  createdAt: Date;
  expiresAt: Date;
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

/** The invitations of one tenant's user pool: issue and mail, list, revoke. */
export interface TenantInvitations {
  /** Issues the invitation (a pending one of the same scope and address is replaced) and mails its link. */
  invite(input: InviteInput): Promise<PendingInvitation>;
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
