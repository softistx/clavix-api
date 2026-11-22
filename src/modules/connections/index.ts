// The module's import surface. Imported by file: `connections.resolver`
// (`modules/index.ts`), `connections.console-resolver`
// (`console/modules/index.ts`), `connections.discovery` and
// `services/connections.service` (`config/connections.ts`, which closes a cycle with
// `config/users.ts` through the barrel) and `connections.errors`
// (`i18n/codes.ts`).

export {
  requireNoSso,
  requireNoSsoForUser,
  revokeIfSso,
} from "./connections.sso-gate";
export { ConnectionsService } from "./services";
