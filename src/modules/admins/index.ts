// The module's import surface (admins: the console's memberships). Imported by
// file, each for a cycle the barrel would close: `admins.console-resolver`
// (`console/modules/index.ts`), `admins.service` (`console/context.ts`) and
// `admins.errors` and `admins.utils` (`users.owners.ts`).

export { refusing } from "./admins.errors";
export { adminInvitationHooks } from "./admins.hooks";
export { createJanusAdmins } from "./admins.janus";
export { AdminsService } from "./admins.service";
export { GRAPHQL_ROLE, membersKey, PLATFORM_OWNERS_KEY } from "./admins.utils";
