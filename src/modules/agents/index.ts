// The module's import surface. The prune queue and worker are not here:
// `server.ts` and `config/redis.ts` import them by file, so this barrel never
// loads the queue. `agents.model` (`AgentKind`) is imported by file by
// `modules/clients`, `agents.prune` and `agents.prune-events` by
// `config/agents-prune.ts` (AGENTS.md "Layout (A12)").

export * from "./agents.model";
export * from "./agents.service";
export * from "./agents.types";
