// The module's import surface. `health.resolver` is imported by file from
// `modules/index.ts`: the generated resolver types never load through this
// barrel, so `config/telemetry` can read `version` without a cycle.

export { type ReadyReport, readiness } from "./health.ready";
export { version } from "./health.version";
