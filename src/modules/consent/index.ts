// The module's import surface (consent: the hosted `/consent` and device pages,
// the approval hooks, the revocation of replaced grants). The resolver is not
// here: `http/schema.ts` imports it by file, so this barrel never loads the
// config wiring back. `consent.device-throttle`, `consent.queue`, the leaf
// readers (`consent.agent-marker`, `consent.detail-labels`,
// `consent.scope-labels`) and `consent.plugin` are imported by file by
// config/*.ts and app.ts, and `consent.errors` by i18n/codes.ts
// (AGENTS.md "Layout (A11)").

export { ConsentService } from "./consent.service";
export type {
  ConsentCtx,
  ConsentOptions,
  LabelledScope,
  RevokeEnqueuer,
  RevokeJob,
  RevokeWorkerQueue,
  ServerSource,
  WithServers,
} from "./consent.types";
