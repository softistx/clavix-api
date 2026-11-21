// The module's import surface. The retention queue and worker are imported by file
// (`config/redis.ts`, `server.ts`), so this barrel never loads the queue;
// `audit.console-resolver` by `console/modules/index.ts`, and `audit.model` by
// `events/types.ts` (a cycle through the barrel).

export type { AuthEventType, AuthMethod } from "./audit.model";
export { authRecorder } from "./audit.recorder";
export { enforceRetention, type RetentionReport } from "./audit.retention";
export * from "./audit.service";
export type { StoredAuthEvent } from "./audit.types";
export { drain } from "./audit.utils";
