// The module's import surface (users: each tenant's janus instance over its
// own partition of the user stores, the OAuth ports built on it, and the
// console's users). Imported by file, each for a cycle the barrel would close:
// `users.console-resolver` (`console/modules/index.ts`), `users.service`
// (`config/console.ts`), `users.utils` (`roles.console-support.ts`) and
// `users.console-mutations` (`lock-order.spec.ts`). `config/users.ts` builds
// the process-wide instances.

export { userLoader } from "./users.data-loader";
export { keepOwners } from "./users.owners";
export { originOf, rpIdOf } from "./users.rp";
export { userSchema } from "./users.schema";
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
  socialOf,
  type TenantJanus,
} from "./users.tenant-janus";
export { requireVerifiedEmail } from "./users.verified-email";
