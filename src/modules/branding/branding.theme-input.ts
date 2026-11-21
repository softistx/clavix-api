import {
  BACKGROUND_PRESETS,
  type BackgroundPreset,
  MOTIF_SHAPES_ALL,
  type MotifShape,
} from "@softistx/material-core/backgrounds";

export interface ThemeInput {
  displayName: string;
  /** The brand's primary colour (`#rgb`, `#rrggbb`, `rgb()`, `oklch()`...). */
  seed: string;
  /** A CSS length in `rem` or `px`, 0 to 3rem. */
  radius: string;
  backgroundPreset: string | null;
  motif: string | null;
}

/** A `ThemeInput` that passed `validateThemeInput`: trimmed, its preset and motif known ids. */
export interface ValidThemeInput extends ThemeInput {
  backgroundPreset: BackgroundPreset | null;
  motif: MotifShape | null;
}

export const DEFAULT_RADIUS = "0.5rem";

export class BrandingInputError extends Error {
  readonly code = "BAD_USER_INPUT";
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

const RADIUS = /^(\d{1,2}(?:\.\d{1,3})?)(rem|px)$/;
const PRESETS = new Set<string>(BACKGROUND_PRESETS.map((p) => p.id));
const SHAPES = new Set<string>(MOTIF_SHAPES_ALL);
const isPreset = (value: string): value is BackgroundPreset =>
  PRESETS.has(value);
const isShape = (value: string): value is MotifShape => SHAPES.has(value);

/** Checks the input's shape; throws `BrandingInputError`. Returns it trimmed. */
export function validateThemeInput(input: ThemeInput): ValidThemeInput {
  const displayName = input.displayName.trim();
  if (displayName === "" || displayName.length > 80) {
    throw new BrandingInputError("displayName", "1 to 80 characters");
  }
  const radius = input.radius.trim();
  const match = RADIUS.exec(radius);
  const value = Number(match?.[1]);
  const max = match?.[2] === "px" ? 48 : 3;
  if (match === null || value > max) {
    throw new BrandingInputError(
      "radius",
      "a length in rem or px, up to 3rem (48px)",
    );
  }
  const { backgroundPreset, motif } = input;
  if (backgroundPreset !== null && !isPreset(backgroundPreset)) {
    throw new BrandingInputError(
      "backgroundPreset",
      "an unknown background preset",
    );
  }
  if (motif !== null && !isShape(motif)) {
    throw new BrandingInputError("motif", "an unknown motif shape");
  }
  return {
    displayName,
    seed: input.seed.trim(),
    radius,
    backgroundPreset,
    motif,
  };
}
