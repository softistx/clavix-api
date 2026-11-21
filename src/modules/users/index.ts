// The module's import surface (users: each tenant's janus instance over its
// own partition of the user stores, the OAuth ports built on it, and the
// console's users). Imported by file, never through here, to keep madge at 6:
// the console resolvers (`console/modules/index.ts`, so this barrel never loads
// the console back), `users.service.ts` and `users.types.ts` (both read the
// invitations types, which import this barrel). `config/users.ts` builds the
// process-wide instances.

export { gone } from "./users.errors";
export {
  createTenantJanusIssuers,
  type TenantJanusOptions,
} from "./users.issuers";
export { originOf, rpIdOf } from "./users.rp";
export { type ClavixUser, userSchema } from "./users.schema";
export {
  ephemeralSecondFactorKeys,
  secondFactorKeysOf,
} from "./users.second-factor-keys";
export {
  MAGIC_LINK_LIFESPAN,
  SESSION,
  SESSION_COOKIE,
  SIGN_IN_CODE_LIFESPAN,
} from "./users.session";
export type { ConnectionsOf } from "./users.social";
export {
  bindSsoCallback,
  connectionIdOfCallbackUrl,
  homeRealmOf,
} from "./users.sso";
export { createTenantAuth } from "./users.tenant-auth";
export {
  buildTenantJanus,
  type InvitationHooks,
  type InvitationHooksFor,
  socialOf,
  type TenantJanus,
  type TenantSocialJanus,
} from "./users.tenant-janus";
export { emailUnverified, requireVerifiedEmail } from "./users.verified-email";
