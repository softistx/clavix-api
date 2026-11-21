// The module's import surface (roles: a tenant's end-user roles and their
// assignments). The console resolvers live in `src/console/modules/roles`
// until A13 folds them in; the hosted API has no roles resolver.
// `i18n/codes.ts` imports `roles.errors` by file (a leaf); `config/roles.ts`
// builds the service (AGENTS.md "Layout (A12, roles)").

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
