// The module's import surface (branding: a tenant's brand, theme and logo).
// `branding.resolver` is imported by file by `modules/index.ts` and
// `branding.console-resolver` by `console/modules/index.ts`, so this barrel never
// loads the config wiring back.

export { codes } from "./branding.errors";
export { LOGO_PATH, logoRoute } from "./branding.logo-route";
export { BrandingService } from "./branding.service";
