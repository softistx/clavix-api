import { defineCodes } from "@/i18n/define-codes";
import { fail } from "@/shared/errors";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("mfa", ["SECOND_FACTOR_DISABLED"]);

/** TOTP is off for the tenant: nobody starts a factor (one that exists is kept). */
export const secondFactorDisabled = () =>
  fail(
    "SECOND_FACTOR_DISABLED",
    "Two-factor authentication is not offered by this tenant",
    { status: 403 },
  );
