// The module's import surface (profile: the standard profile fields of a
// user, their rules and the tenant's locks). Role files with several members
// are folders with a barrel (`services/`, `rules/`, `utils/`).
// `profile.console-resolver` is loaded by file by `console/modules/index.ts`.
// Allowed deep imports (leaf files): `profile.errors` (read by
// `i18n/codes.ts`), `profile.schema` (read by `users.schema`) and
// `profile.model` (read by `collections.ts`).
// `profile.refusals` is re-exported for the users module.

export { refuse, refuseCommon } from "./profile.refusals";
export type { ProfileChanges, ProfileView } from "./profile.types";
export { cleanProfile } from "./rules";
export { ProfilePoliciesService } from "./services";
export {
  emptyProfile,
  patchOf,
  profileOf,
  standardClaims,
} from "./utils";
