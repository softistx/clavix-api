import { JanusError } from "@softistx/janus";
import {
  type InvitationSource,
  type PendingInvitation,
  toPending,
} from "./invitation-source";
import { DEFAULT_MAX_PENDING, guardInvite } from "./invite-guards";
import {
  RESEND_COOLDOWN_MS,
  type ResendInput,
  resendInvitation,
} from "./resend";

export type {
  InvitationSource,
  InvitationsAuth,
  PendingInvitation,
} from "./invitation-source";
export {
  RESEND_COOLDOWN_MS,
  type ResendInput,
  type ResendRefusal,
  ResendRefusedError,
} from "./resend";

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
  {
    now = Date.now,
    cooldownMs = RESEND_COOLDOWN_MS,
    maxPending = DEFAULT_MAX_PENDING,
  }: InvitationsOptions = {},
): TenantInvitations {
  const need = async () => {
    const found = await source();
    if (found === null) throw new TenantUnavailableError();
    return found;
  };
  return {
    async invite({ scope, organization, email, role, invitedBy }) {
      const { auth, mail, link } = await need();
      await guardInvite(auth, { now, cooldownMs, maxPending }, scope, email);
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
    async resend(input) {
      return resendInvitation(await need(), { now, cooldownMs }, input);
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
