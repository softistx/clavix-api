import { defineCodes } from "@/i18n/define-codes";
import { fail } from "@/shared/errors";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("consent", [
  "DEVICE_CODE_THROTTLED",
  "UNMET_AUTHENTICATION_REQUIREMENTS",
]);

/** `DEVICE_CODE_THROTTLED`, 429, `retryAfter` in the error and `Retry-After` (seconds). */
export const deviceCodeThrottled = (retryAfter: number) =>
  fail("DEVICE_CODE_THROTTLED", "Too many device codes tried", {
    status: 429,
    retryAfter,
  });

/** D10: a request the session cannot meet is not approved; the answer carries what is missing so the page can lead the user to it. */
export const unmetAuthentication = (missing: readonly string[]) =>
  fail(
    "UNMET_AUTHENTICATION_REQUIREMENTS",
    "unmet_authentication_requirements",
    {
      status: 403,
      extra: {
        oauthError: "unmet_authentication_requirements",
        missing: [...missing],
      },
    },
  );

/**
 * Approval is all or nothing (D4) and allows only what the page showed: a
 * request whose details cannot be fully described (type deleted, a key the
 * type no longer defines) is refused before janus approves it, as an invalid
 * authorization details input; it stays pending and can be denied.
 */
export const refuseIncomplete = () =>
  fail("BAD_USER_INPUT", "invalid_authorization_details", {
    extra: { oauthError: "invalid_authorization_details" },
  });
