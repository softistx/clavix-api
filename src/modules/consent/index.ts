// The module's import surface (consent: the hosted `/consent` and device pages,
// the approval hooks, the revocation of replaced grants). Imported by file:
// `consent.resolver` (`http/schema.ts`), `consent.plugin` (`app.ts`),
// `consent.device-throttle` and `consent.queue` (`config/redis.ts`) and
// `consent.errors` (`i18n/codes.ts`), so this barrel never loads the config
// wiring or the queue.

export type { AgentsFor } from "./consent.agent-marker";
export type { DetailTextsFor } from "./consent.detail-labels";
export { createDeviceThrottle } from "./consent.device-throttle";
export type { ScopeTextsFor } from "./consent.scope-labels";
export { ConsentService } from "./consent.service";
export type { RevokeEnqueuer, RevokeJob } from "./consent.types";
