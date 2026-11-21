import type { InvitationsAuth, PendingInvitation } from "./invitation-source";
import { ResendRefusedError } from "./resend";

/** The most pending invitations of one scope (one tenant's pool or admin list). */
export const DEFAULT_MAX_PENDING = 500;

/**
 * Refuses an invitation that would work around the resend cooldown or pile up
 * pending invitations. Reads the scope's pending invitations from the store
 * (no Redis: it holds across processes and while Redis is down). The check
 * and the write are not atomic; the cap may be exceeded by concurrent invites.
 */
export async function guardInvite(
  auth: InvitationsAuth,
  {
    now,
    cooldownMs,
    maxPending,
  }: { now: () => number; cooldownMs: number; maxPending: number },
  scope: string,
  email: string,
): Promise<void> {
  const wanted = email.trim().toLowerCase();
  let count = 0;
  let replaced: { updatedAt: Date } | null = null;
  let after: string | null = null;
  do {
    const page = await auth.invitations.list(scope, {
      status: "pending",
      lapsed: "exclude",
      limit: 100,
      after,
    });
    for (const item of page.items) {
      count += 1;
      if (item.email.trim().toLowerCase() === wanted) replaced = item;
    }
    after = page.nextCursor;
  } while (after !== null);
  if (replaced !== null) {
    const wait = replaced.updatedAt.getTime() + cooldownMs - now();
    if (wait > 0) {
      throw new ResendRefusedError("INVITE_TOO_SOON", Math.ceil(wait / 1000));
    }
    return;
  }
  if (count >= maxPending) {
    throw new ResendRefusedError("PENDING_INVITATIONS_LIMIT");
  }
}

export type { PendingInvitation };
