import { defineCodes } from "@/i18n/define-codes";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("branding", ["BRANDING_CONTRAST"]);

/** Other calls kept changing the brand while this one tried (`CONFLICT`): nothing of it was stored. */
export class BrandingConflictError extends Error {
  readonly code = "CONFLICT";
  constructor() {
    super("The brand was changed by another call; read it and try again");
  }
}
