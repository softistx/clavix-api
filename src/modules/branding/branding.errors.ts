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

export class BrandingInputError extends Error {
  readonly code = "BAD_USER_INPUT";
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** The brand's colours do not meet WCAG AA (`BRANDING_CONTRAST`). */
export class BrandingContrastError extends Error {
  readonly code = "BRANDING_CONTRAST";
  constructor(readonly failures: readonly ContrastFailure[]) {
    super(
      `The theme fails WCAG AA on ${failures.length} pair(s): ${failures
        .slice(0, 3)
        .map((f) => `${f.foreground} on ${f.background} (${f.mode}) ${f.ratio}`)
        .join(", ")}`,
    );
  }
}

/** A pair that fails its minimum ratio in one mode. */
export interface ContrastFailure {
  foreground: string;
  background: string;
  mode: string;
  ratio: number;
  minimum: number;
}
