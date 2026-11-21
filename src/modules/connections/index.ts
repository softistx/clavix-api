// The module's import surface. The resolver is not here: `modules/index.ts`
// imports it by file, so this barrel never loads the config wiring back.

export type { IssuerChecker, IssuerSummary } from "./connections.discovery";
export { discoverIssuer } from "./connections.discovery";
export { ConnectionError } from "./connections.errors";
export type { ConnectionDoc } from "./connections.model";
export {
  type OpenedSession,
  requireNoSso,
  requireNoSsoForUser,
  revokeIfSso,
} from "./connections.sso-gate";
export type {
  ClaimsInput,
  ConnectionInput,
  ConnectionPatch,
  LinkCounter,
} from "./connections.types";
export { txtNameOf } from "./connections.utils";
export { ConnectionsService } from "./services";
