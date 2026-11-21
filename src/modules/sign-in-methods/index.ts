// The module's import surface. `sign-in-methods.resolver` (`modules/index.ts`)
// and `sign-in-methods.console-resolver` (`console/modules/index.ts`) are
// imported by file, because their support loads the config wiring, which would
// close an import cycle through this barrel; `sign-in-methods.schema` is
// imported by file by the tenants model and `tenancy/resolved-tenant.ts`. The
// schema comes first: the tenants model builds its own schema from it when it
// is evaluated.

export { codes } from "./sign-in-methods.errors";
export * from "./sign-in-methods.gate";
export {
  isEnabled,
  sealedSecretSchema,
  signInPolicySchema,
} from "./sign-in-methods.schema";
export * from "./sign-in-methods.secrets";
export * from "./sign-in-methods.service";
export * from "./sign-in-methods.social";
export {
  createHomeRealmThrottle,
  createSsoStartThrottle,
  ssoLimits,
} from "./sign-in-methods.sso-throttle";
