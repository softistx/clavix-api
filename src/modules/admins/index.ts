// The module's import surface (admins: the console's memberships). Imported by
// file: `admins.console-resolver` (`console/modules/index.ts`) and
// `admins.service` (`console/context.ts`: the barrel would close a cycle through
// `admins.janus`, which takes the context's types).

export { lastOwnerError, refusing } from "./admins.errors";
export { adminInvitationHooks } from "./admins.hooks";
export { createJanusAdmins } from "./admins.janus";
export { AdminsService } from "./admins.service";
export { GRAPHQL_ROLE, membersKey, PLATFORM_OWNERS_KEY } from "./admins.utils";
