// The module's import surface (profile: the standard profile fields of a
// user, their rules and the tenant's locks). Role files with several members
// are folders with a barrel (`services/`, `rules/`, `utils/`).
// `profile.console-resolver` is loaded by file by `console/modules/index.ts`.
// Allowed deep imports (leaf files): `profile.errors` (read by
// `i18n/codes.ts`), `profile.schema` (read by `users.schema`) and
// `profile.model` (read by `collections.ts`).
// `profile.refusals` is re-exported for the users module.

export type { ProfileField } from "./profile.model";
export { PROFILE_FIELDS } from "./profile.model";
export { refuse, refuseCommon } from "./profile.refusals";
export type {
  Address,
  Phone,
  ProfileChanges,
  ProfileInput,
  ProfileView,
} from "./profile.types";
export { checkUnlocked, cleanProfile, touchedFields } from "./rules";
export { ProfilePoliciesService } from "./services";
export {
  emptyProfile,
  nextPhone,
  patchOf,
  profileOf,
  standardClaims,
} from "./utils";
