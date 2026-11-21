// The module's import surface (clients: a tenant's OAuth clients). The console
// resolvers are `clients.console-resolver.ts`, loaded by `console/modules`;
// `config/clients.ts` builds the service. `parseClientArgs` and `USAGE` are
// the `clients:create` script's.

export { parseClientArgs, USAGE } from "./clients.cli";
export { registerClient } from "./clients.register";
export {
  clientIdOf,
  DEFAULT_GRANTS,
  OFFERED_GRANTS,
  usesRedirect,
} from "./clients.rules";
export { ClientsService } from "./clients.service";
export type {
  ClientRegistration,
  ClientsServiceOptions,
  ClientView,
  OfferedGrant,
  RegisterClientInput,
  RegisterClientOptions,
  RegisteredClient,
} from "./clients.types";
export { clientsKey } from "./clients.utils";
