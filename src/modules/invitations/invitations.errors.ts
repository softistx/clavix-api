import { JanusError } from "@softistx/janus";
import { defineCodes } from "@/i18n/define-codes";
import { fail } from "@/shared/errors";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("invitations", [
  "INVITATION_INVALID",
  "INVITATION_NOT_PENDING",
  "RESEND_TOO_SOON",
  "INVITE_TOO_SOON",
  "PENDING_INVITATIONS_LIMIT",
]);

/** The one refusal of an unknown, spent, revoked or lapsed code. */
export const invalid = () =>
  fail("INVITATION_INVALID", "The invitation is invalid or has expired", {
    status: 400,
  });

/** Runs a janus call and answers every refusal alike, so a code cannot be told apart from a spent one. */
export async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof JanusError && error.code !== "STORE_FAILED") {
      throw invalid();
    }
    throw error;
  }
}

/**
 * Why an invitation was not sent: `resend` refuses the first three,
 * `invite` the last two (`INVITE_TOO_SOON`, `PENDING_INVITATIONS_LIMIT`).
 */
export type ResendRefusal =
  | "NOT_FOUND"
  | "INVITATION_NOT_PENDING"
  | "RESEND_TOO_SOON"
  | "INVITE_TOO_SOON"
  | "PENDING_INVITATIONS_LIMIT";

/** `resend` or `invite` refused: nothing was written and no mail went out. */
export class ResendRefusedError extends Error {
  constructor(
    readonly code: ResendRefusal,
    /** `RESEND_TOO_SOON` and `INVITE_TOO_SOON`: whole seconds until it may be sent again. */
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = "ResendRefusedError";
  }
}

/** The tenant is missing or suspended: the call did nothing. */
export class TenantUnavailableError extends Error {
  constructor() {
    super("the tenant is not available");
    this.name = "TenantUnavailableError";
  }
}

/** The code of a janus error that says the invitation is not this scope's or no longer pending; `null` for any other error. */
export function goneCode(
  error: unknown,
): "NOT_FOUND" | "INVITATION_NOT_PENDING" | null {
  if (!(error instanceof JanusError)) return null;
  return error.code === "NOT_FOUND" || error.code === "INVITATION_NOT_PENDING"
    ? error.code
    : null;
}
