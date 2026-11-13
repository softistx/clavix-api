import {
  BACKGROUND_PRESETS,
  MOTIF_SHAPES_ALL,
} from "@softistx/material-core/backgrounds";
import {
  type ContrastResult,
  checkThemeContrast,
  defineTheme,
  type ThemeWarning,
  themeToCss,
} from "@softistx/material-core/theme";

/** The theme's name: the value of `data-nxgt-theme` the hosted pages and the console preview set. */
export const THEME_NAME = "tenant";

export interface ThemeInput {
  displayName: string;
  /** The brand's primary colour (`#rgb`, `#rrggbb`, `rgb()`, `oklch()`...). */
  seed: string;
  /** A CSS length in `rem` or `px`, 0 to 3rem. */
  radius: string;
  backgroundPreset: string | null;
  motif: string | null;
}

export const DEFAULT_RADIUS = "0.5rem";

/** A pair that fails its minimum ratio in one mode. */
export interface ContrastFailure {
  foreground: string;
  background: string;
  mode: string;
  ratio: number;
  minimum: number;
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

export interface CompiledTheme {
  css: string;
  /** What the generator adjusted to reach AA (a seed moved lighter or darker...). */
  warnings: string[];
  results: readonly ContrastResult[];
  /** Warnings that mean a pair could not be made AA. */
  unsolved: readonly ThemeWarning[];
}

/** Compiles a theme and measures it; what `updateBranding` runs. Injectable for specs. */
export type CompileTheme = (input: ThemeInput) => CompiledTheme;

const RADIUS = /^(\d{1,2}(?:\.\d{1,3})?)(rem|px)$/;
const PRESETS = new Set<string>(BACKGROUND_PRESETS.map((p) => p.id));
const SHAPES = new Set<string>(MOTIF_SHAPES_ALL);

/** Checks the input's shape; throws `BrandingInputError`. Returns it trimmed. */
export function validateThemeInput(input: ThemeInput): ThemeInput {
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
  if (input.backgroundPreset !== null && !PRESETS.has(input.backgroundPreset)) {
    throw new BrandingInputError(
      "backgroundPreset",
      "an unknown background preset",
    );
  }
  if (input.motif !== null && !SHAPES.has(input.motif)) {
    throw new BrandingInputError("motif", "an unknown motif shape");
  }
  return {
    displayName,
    seed: input.seed.trim(),
    radius,
    backgroundPreset: input.backgroundPreset,
    motif: input.motif,
  };
}

/** The real compiler: `defineTheme`, `themeToCss({ scope: "attribute" })` and `checkThemeContrast`. */
export const compileTheme: CompileTheme = (input) => {
  let theme: ReturnType<typeof defineTheme>;
  try {
    theme = defineTheme({
      name: THEME_NAME,
      label: input.displayName,
      colors: { primary: input.seed },
      radius: input.radius,
      ...(input.backgroundPreset === null
        ? {}
        : {
            background: {
              preset: input.backgroundPreset as never,
              intensity: "subtle",
              ...(input.motif === null
                ? {}
                : { motif: { shapes: [input.motif as never] } }),
            },
          }),
    });
  } catch (error) {
    // ThemeDefinitionError: an unreadable colour or an unsafe value.
    throw new BrandingInputError(
      "seed",
      error instanceof Error ? error.message : "invalid theme",
    );
  }
  const { css, palette, warnings } = themeToCss(theme, {
    scope: "attribute",
  });
  return {
    css,
    warnings: warnings.map((w) => w.message),
    results: [
      ...palette.contrast,
      ...checkThemeContrast(palette.light, palette.dark),
    ],
    unsolved: warnings.filter(
      (w) => w.code === "unsolvable" || w.code === "override-breaks-pair",
    ),
  };
};

/** The failing pairs of a compiled theme, without duplicates. */
export function failuresOf(compiled: CompiledTheme): ContrastFailure[] {
  const seen = new Set<string>();
  const failures: ContrastFailure[] = [];
  for (const r of compiled.results) {
    if (r.pass) continue;
    const key = `${r.fg}|${r.bg}|${r.mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({
      foreground: r.fg,
      background: r.bg,
      mode: r.mode,
      ratio: Math.round(r.ratio * 100) / 100,
      minimum: r.min,
    });
  }
  for (const w of compiled.unsolved) {
    failures.push({
      foreground: w.token ?? "unknown",
      background: "",
      mode: w.mode ?? "light",
      ratio: 0,
      minimum: 4.5,
    });
  }
  return failures;
}

/** Validates, compiles and checks AA in light and dark; throws `BrandingContrastError` when a pair fails. */
export function buildTheme(
  input: ThemeInput,
  compile: CompileTheme = compileTheme,
): { input: ThemeInput; compiled: CompiledTheme } {
  const valid = validateThemeInput(input);
  const compiled = compile(valid);
  const failures = failuresOf(compiled);
  if (failures.length > 0) throw new BrandingContrastError(failures);
  return { input: valid, compiled };
}
