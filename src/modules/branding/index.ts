// The module's import surface (branding: a tenant's brand, theme and logo).
// The resolver is not here: `modules/index.ts` imports it by file, so this
// barrel never loads the config wiring back. `branding.logo-route` is also
// imported by file by app.ts and config/branding.ts, and `branding.errors` by
// i18n/codes.ts (AGENTS.md "Layout (A11)").

export { BrandingConflictError } from "./branding.errors";
export { checkLogo, LOGO_MAX_BYTES, type StoredLogo } from "./branding.logo";
export { BrandingService } from "./branding.service";
export {
  BrandingContrastError,
  BrandingInputError,
  buildTheme,
  type CompileTheme,
  compileTheme,
  THEME_NAME,
  type ThemeInput,
  type ValidThemeInput,
} from "./branding.theme";
export type {
  PublicBranding,
  StoredBrandingDoc,
  UpdateBrandingInput,
  UpdateBrandingResult,
} from "./branding.types";
