import { JanusError } from "@softistx/janus";
import {
  type InvitationSource,
  type PendingInvitation,
  toPending,
} from "./invitation-source";

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

/**
 * Sends a pending invitation again with a new code and lifetime, and mails the
 * new link; `ResendRefusedError` when it may not (see `TenantInvitations.resend`).
 */
export async function resendInvitation(
  { auth, mail, link }: InvitationSource,
  { now, cooldownMs }: { now: () => number; cooldownMs: number },
  { scope, invitationId, organization, by }: ResendInput,
): Promise<PendingInvitation> {
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
}
