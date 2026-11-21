// The module's import surface. The prune queue and worker are imported by file
// (`config/redis.ts`, `server.ts`), so this barrel never loads the queue.

export type { AgentKind } from "./agents.model";
export { type PruneReport, pruneAgents } from "./agents.prune";
export { agentPruneEventInput } from "./agents.prune-events";
export * from "./agents.service";
export type { AgentClientsPort } from "./agents.types";
