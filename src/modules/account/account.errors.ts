import { defineCodes } from "@/i18n/define-codes";
import { fail } from "@/shared/errors";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("account", ["EMAIL_CHANGE_INVALID"]);

/** Every refusal of a change token alike (unknown, spent, expired, stale): the page offers a new request whatever went wrong. */
export const emailChangeInvalid = () =>
  fail(
    "EMAIL_CHANGE_INVALID",
    "The e-mail change link is invalid or has expired",
    {
      status: 400,
    },
  );
