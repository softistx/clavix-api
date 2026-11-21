// The module's import surface (roles: a tenant's end-user roles and their
// assignments). The console resolvers live in `src/console/modules/roles`
// until A13 folds them in; the hosted API has no roles resolver. The errors
// are imported by file by `i18n/codes.ts` and `console/modules/catalog-support.ts`,
// and `RolesService` by `config/roles.ts` (AGENTS.md "Layout (A12)").

export type { RolesErrorCode } from "./roles.errors";
export { RolesError } from "./roles.errors";
export { RolesService } from "./roles.service";
export type {
  AssignmentDoc,
  CreateRoleInput,
  MembersPage,
  RoleDoc,
  RolesOptions,
  UpdateRoleInput,
} from "./roles.types";
