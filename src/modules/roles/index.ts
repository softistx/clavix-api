// The module's import surface (roles: a tenant's end-user roles and their
// assignments). `roles.console-resolver` is loaded by file by
// `console/modules/index.ts`; the hosted API has no roles resolver.
// `config/roles.ts` builds the service.

export { codes, RolesError } from "./roles.errors";
export { RolesService } from "./roles.service";
