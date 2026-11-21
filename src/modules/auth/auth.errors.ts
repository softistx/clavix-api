import { defineCodes } from "@/i18n/define-codes";
import { fail } from "@/shared/errors";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("auth", [
  "CODE_INVALID",
  "EMAIL_UNVERIFIED",
  "EMAIL_VERIFICATION_INVALID",
  "EMAIL_VERIFICATION_THROTTLED",
  "MAGIC_LINK_DISABLED",
  "MAGIC_LINK_INVALID",
]);

/** Every refusal alike: a decoy challenge must not read differently from a real one. */
export const codeInvalid = () =>
  fail("CODE_INVALID", "The code is wrong or has expired", { status: 401 });

/** The surface does not exist while the switch is off: 404, nothing counted, issued or sent. */
export const magicLinkDisabled = () =>
  fail("MAGIC_LINK_DISABLED", "Magic-link sign-in is disabled", {
    status: 404,
  });

/** Every refusal alike: the page offers a new link whatever went wrong. */
export const magicLinkInvalid = () =>
  fail("MAGIC_LINK_INVALID", "The link is invalid or has expired", {
    status: 401,
  });

/** Every refusal alike: the page offers a new link whatever went wrong. */
export const emailVerificationInvalid = () =>
  fail(
    "EMAIL_VERIFICATION_INVALID",
    "The verification link is invalid or has expired",
    { status: 400 },
  );

/** `EMAIL_VERIFICATION_THROTTLED`, 429, `retryAfter` in the error and `Retry-After` (seconds). */
export const emailVerificationThrottled = (retryAfter: number) =>
  fail(
    "EMAIL_VERIFICATION_THROTTLED",
    "Too many verification e-mails requested",
    { status: 429, retryAfter },
  );
