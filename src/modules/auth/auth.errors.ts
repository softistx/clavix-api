import { defineCodes } from "@/i18n/define-codes";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("auth", [
  "CODE_INVALID",
  "EMAIL_UNVERIFIED",
  "EMAIL_VERIFICATION_INVALID",
  "EMAIL_VERIFICATION_THROTTLED",
  "MAGIC_LINK_DISABLED",
  "MAGIC_LINK_INVALID",
]);
