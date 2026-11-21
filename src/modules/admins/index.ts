// The module's import surface (admins: the console's memberships). The console
// resolvers are `admins.console-resolver.ts`, loaded by `console/modules`;
// the console plugin builds the service. The invitation hooks and the janus
// port are imported by file where they are wired (`config/users.ts`,
// `config/console.ts`).

export { AdminsService } from "./admins.service";
export type {
  AdminsAccess,
  AdminsDirectory,
  AdminsServiceOptions,
  DirectoryUser,
  Member,
} from "./admins.types";
export {
  membersKey,
  PLATFORM_OWNERS_KEY,
  roleOf,
} from "./admins.utils";
