// The module's import surface. The retention queue and worker are not here:
// `server.ts` and `config/redis.ts` import them by file, so this barrel never
// loads the queue. `audit.model` (the event types, imported by `events/` and
// the auth and mfa modules), `audit.recorder` (`config/events.ts`),
// `audit.retention` (`config/audit-retention.ts`) and `audit.utils` (`drain`,
// the console's export reader) are leaves imported by file (AGENTS.md
// "Layout (A12)").

export * from "./audit.model";
export * from "./audit.service";
export * from "./audit.types";
