// The module's import surface (profile: the standard profile fields of a
// user, their rules and the tenant's locks). Single-file roles stay flat at the
// module root (`profile.service`, `profile.rules`); only `utils/` holds several files.
// `profile.console-resolver` is loaded by file by `console/modules/index.ts`.
// Allowed deep imports (leaf files): `profile.errors` (read by
// `i18n/codes.ts`), `profile.schema` (read by `users.schema`) and
// `profile.model` (read by `collections.ts`).
// `profile.refusals` is re-exported for the users module.

export { refuse, refuseCommon } from "./profile.refusals";
export { checkUnlocked, cleanProfile } from "./profile.rules";
export { ProfilePoliciesService } from "./profile.service";
export type { ProfileChanges, ProfileView } from "./profile.types";
export {
  emptyProfile,
  patchOf,
  profileOf,
  standardClaims,
} from "./utils";
