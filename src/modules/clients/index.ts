// The module's import surface (clients: a tenant's OAuth clients).
// `clients.console-resolver` is loaded by file by `console/modules/index.ts`;
// `config/clients.ts` builds the service. `parseClientArgs` and `USAGE` are the
// `clients:create` script's.

export { parseClientArgs, USAGE } from "./clients.cli";
export { registerClient } from "./clients.register";
export { ClientsService } from "./clients.service";
export type { AgentKindsOf, AgentsReader } from "./clients.types";
export { clientsKey } from "./clients.utils";
