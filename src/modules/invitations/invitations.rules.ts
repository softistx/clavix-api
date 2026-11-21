import { ResendRefusedError } from "./invitations.errors";
import type { StoredInvitation } from "./invitations.types";

/** The most pending invitations of one scope (one tenant's pool or admin list). */
export const DEFAULT_MAX_PENDING = 500;

/** The least time between two sends of one invitation. */
export const RESEND_COOLDOWN_MS = 60_000;

/** Whole seconds until an invitation last written at `updatedAt` may be sent again; `0` when it may. */
export function retryAfterSeconds(
  updatedAt: Date,
  cooldownMs: number,
  now: number,
): number {
  const wait = updatedAt.getTime() + cooldownMs - now;
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

/**
 * The refusal of an invitation that would work around the resend cooldown or
 * pile up pending invitations, given the scope's pending ones; `null` when it
 * may go. A pending invitation of the same address (the last one listed) is
 * replaced once it is older than the cooldown; a new address past the cap is
 * refused.
 */
export function inviteRefusal(
  pending: readonly StoredInvitation[],
  email: string,
  limits: { now: number; cooldownMs: number; maxPending: number },
): ResendRefusedError | null {
  const wanted = email.trim().toLowerCase();
  const replaced = pending.findLast(
    (item) => item.email.trim().toLowerCase() === wanted,
  );
  if (replaced !== undefined) {
    const wait = retryAfterSeconds(
      replaced.updatedAt,
      limits.cooldownMs,
      limits.now,
    );
    return wait > 0 ? new ResendRefusedError("INVITE_TOO_SOON", wait) : null;
  }
  return pending.length >= limits.maxPending
    ? new ResendRefusedError("PENDING_INVITATIONS_LIMIT")
    : null;
}

const ADMIN = "admin:";

/**
 * The scope of an invitation to administer a tenant (a console role on it),
 * issued in the `clavix` tenant. Any other scope is an invitation into a
 * tenant's own user pool and grants no console role.
 */
export const adminScope = (tenantId: string) => `${ADMIN}${tenantId}`;

/** The tenant an admin invitation's scope names, or `null` for any other scope. */
export const adminTenantOf = (scope: string): string | null =>
  scope.startsWith(ADMIN) ? scope.slice(ADMIN.length) : null;

/**
 * The scope of an invitation into a tenant's own user pool, issued by that
 * tenant's console admins. Accepting it makes the account and grants nothing else.
 */
export const userScope = () => "users";

const OPERATOR = "operator";

/**
 * The scope of an invitation to become a platform operator, issued in the
 * `clavix` tenant by `operators:grant --create`. Accepting it makes the account
 * and grants the invitation's role on the platform.
 */
export const operatorScope = () => OPERATOR;

/** Whether the scope is the operator invitation one. */
export const isOperatorScope = (scope: string): boolean => scope === OPERATOR;
