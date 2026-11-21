import { defineCodes } from "@/i18n/define-codes";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("invitations", [
  "INVITATION_INVALID",
  "INVITATION_NOT_PENDING",
  "RESEND_TOO_SOON",
  "INVITE_TOO_SOON",
  "PENDING_INVITATIONS_LIMIT",
]);
