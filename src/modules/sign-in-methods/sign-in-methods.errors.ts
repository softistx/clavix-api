import type { ErrorCode } from "@/i18n/codes";
import { defineCodes } from "@/i18n/define-codes";
import { fail } from "@/shared/errors";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("sign-in-methods", [
  "SIGN_IN_METHOD_DISABLED",
  "SIGN_IN_METHOD_UNAVAILABLE",
  "SOCIAL_SECRET_REQUIRED",
  "PLATFORM_FIRST_PARTY_METHOD",
  "NO_SIGN_IN_METHOD",
]);

/** A refusal of the policy service: a code of the inventory, its message and its HTTP status. */
export const refusal = (code: ErrorCode, message: string, status: number) =>
  fail(code, message, { status });

/** `BAD_USER_INPUT` (400) with the message given. */
export const badInput = (message: string) =>
  refusal("BAD_USER_INPUT", message, 400);

/** A method the tenant did not turn on does not exist: 404, before any budget, store or mail is touched. */
export const methodDisabled = (method: string) =>
  refusal("SIGN_IN_METHOD_DISABLED", `Sign-in by ${method} is disabled`, 404);
