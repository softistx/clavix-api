import type { ErrorCode } from "@/i18n/codes";
import { fail } from "@/shared/errors";

const refusal = (code: ErrorCode, message: string, status: number) =>
  fail(code, message, { status });

/** An unknown or trashed tenant: NOT_FOUND (404). */
export const tenantNotFound = () => refusal("NOT_FOUND", "No such tenant", 404);

/** A value of the agents policy that is wrong; the message says which: BAD_USER_INPUT (400). */
export const badAgentsInput = (message: string) =>
  refusal("BAD_USER_INPUT", message, 400);

/** The policy changed under the caller (the tenant's version moved): CONFLICT (409). */
export const policyConflict = () =>
  refusal(
    "CONFLICT",
    "The OAuth policy was changed at the same time; read it and try again",
    409,
  );

/** A value of the input that is wrong; the message says which. */
export class AgentsInputError extends Error {
  override name = "AgentsInputError";
}
