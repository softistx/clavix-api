// The module's import surface (users: each tenant's janus instance over its
// own partition of the user stores, the OAuth ports built on it, and the
// console's users). Imported by file: `users.console-resolver`
// (`console/modules/index.ts`), `users.console-mutations` (`lock-order.spec.ts`)
// and the type `TenantJanus` of `users.tenant-janus` (`http/context.ts`,
// `invitations.types.ts`, `invitations.service.ts`: the barrel would close a cycle
// through `users.service` and the invitations). `config/users.ts` builds the
// process-wide instances.

export { userLoader } from "./users.data-loader";
export { keepOwners } from "./users.owners";
export { originOf, rpIdOf } from "./users.rp";
export { userSchema } from "./users.schema";
export {
  ephemeralSecondFactorKeys,
  secondFactorKeysOf,
} from "./users.second-factor-keys";
export { UsersService } from "./users.service";
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
export { shape } from "./users.utils";
export { requireVerifiedEmail } from "./users.verified-email";
