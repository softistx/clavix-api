import {
  type ResendRefusal,
  ResendRefusedError,
} from "@/modules/invitations/invitations.errors";
import { fail } from "@/shared/errors";

const RESEND_STATUS = {
  NOT_FOUND: 404,
  INVITATION_NOT_PENDING: 409,
  RESEND_TOO_SOON: 429,
  INVITE_TOO_SOON: 429,
  PENDING_INVITATIONS_LIMIT: 409,
} as const satisfies Record<ResendRefusal, number>;

const RESEND_MESSAGE = {
  NOT_FOUND: "No such invitation",
  INVITATION_NOT_PENDING: "The invitation was accepted or revoked",
  RESEND_TOO_SOON: "The invitation was sent less than a minute ago",
  INVITE_TOO_SOON: "This address was invited less than a minute ago",
  PENDING_INVITATIONS_LIMIT: "Too many pending invitations; revoke some first",
} as const satisfies Record<ResendRefusal, string>;

const conflict = (code: "LAST_OWNER" | "ALREADY_MEMBER", message: string) =>
  fail(code, message, { status: 409 });

/** The refusal of a change that would leave a tenant, or the platform, with no owner who can sign in. */
export const lastOwnerError = (of: "tenant" | "platform" = "tenant") =>
  conflict("LAST_OWNER", `A ${of} keeps at least one owner`);

/** The refusal of an invitation, or a role, for a user who already holds one on the tenant. */
export const alreadyMember = () =>
  conflict("ALREADY_MEMBER", "Already an admin of this tenant");

// A resend's or an invite's refusals as the contract's GraphQL errors.
export async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ResendRefusedError)) throw error;
    const { code, retryAfter } = error;
    throw fail(code, RESEND_MESSAGE[code], {
      status: RESEND_STATUS[code],
      retryAfter,
    });
  }
}
