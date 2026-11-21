import {
  type ContrastResult,
  checkThemeContrast,
  defineTheme,
  type Theme,
  type ThemeDefinition,
  type ThemeWarning,
  themeToCss,
} from "@softistx/material-core/theme";
import {
  BrandingContrastError,
  BrandingInputError,
  type ContrastFailure,
} from "./branding.errors";
import { assertSafeCss } from "./branding.safe-css";
import {
  type ThemeInput,
  type ValidThemeInput,
  validateThemeInput,
} from "./branding.theme-input";

export { assertSafeCss } from "./branding.safe-css";
export {
  DEFAULT_RADIUS,
  type ThemeInput,
  type ValidThemeInput,
  validateThemeInput,
} from "./branding.theme-input";

/** The theme's name: the value of `data-nxgt-theme` the hosted pages and the console preview set. */
export const THEME_NAME = "tenant";

export interface CompiledTheme {
  css: string;
  /** What the generator adjusted to reach AA (a seed moved lighter or darker...). */
  warnings: string[];
  results: readonly ContrastResult[];
  /** Warnings that mean a pair could not be made AA. */
  unsolved: readonly ThemeWarning[];
}

/** Compiles a theme and measures it; what `updateBranding` runs. Injectable for specs. */
export type CompileTheme = (input: ValidThemeInput) => CompiledTheme;

/** The theme definition of a brand: one seed, a radius, and the background when a preset is chosen. */
export function themeDefinitionOf(input: ValidThemeInput): ThemeDefinition {
  return {
    name: THEME_NAME,
    label: input.displayName,
    colors: { primary: input.seed },
    radius: input.radius,
    ...(input.backgroundPreset === null
      ? {}
      : {
          background: {
            preset: input.backgroundPreset,
            intensity: "subtle",
            ...(input.motif === null
              ? {}
              : { motif: { shapes: [input.motif] } }),
          },
        }),
  };
}

/**
 * Generates a theme's stylesheet (`themeToCss`, attribute scope) and measures
 * every pair in light and dark (`checkThemeContrast`).
 */
export function measureTheme(theme: Theme): CompiledTheme {
  const { css, palette, warnings } = themeToCss(theme, {
    scope: "attribute",
  });
  // The hosted pages put this text in a `<style>`: the generator writes
  // colours and lengths it parsed, never the input, so nothing reaches this
  // today. It is a backstop: it refuses anything that could close the element
  // should the generator ever change.
  assertSafeCss(css);
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
}

/** The real compiler: `defineTheme`, then `measureTheme`. */
export const compileTheme: CompileTheme = (input) => {
  let theme: Theme;
  try {
    theme = defineTheme(themeDefinitionOf(input));
  } catch (error) {
    // ThemeDefinitionError: an unreadable colour or an unsafe value.
    throw new BrandingInputError(
      "seed",
      error instanceof Error ? error.message : "invalid theme",
    );
  }
  return measureTheme(theme);
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
  // A pair the generator gave up on normally fails its measure above too; the
  // warning adds a line only when no measured pair already names its token.
  for (const w of compiled.unsolved) {
    const mode = w.mode ?? "light";
    const measured = failures.some(
      (f) =>
        f.mode === mode &&
        (f.foreground === w.token || f.background === w.token),
    );
    if (measured) continue;
    failures.push({
      foreground: w.token ?? "unknown",
      background: "",
      mode,
      ratio: 0,
      minimum: 4.5,
    });
  }
  return failures;
}

/** Validates, compiles and checks AA in light and dark; throws `BrandingContrastError` when a pair fails. */
export function buildTheme(
  input: ThemeInput,
  compile: CompileTheme,
): { input: ValidThemeInput; compiled: CompiledTheme } {
  const valid = validateThemeInput(input);
  const compiled = compile(valid);
  assertSafeCss(compiled.css);
  const failures = failuresOf(compiled);
  if (failures.length > 0) throw new BrandingContrastError(failures);
  return { input: valid, compiled };
}
