// The module's import surface. The purge queue and worker are imported by file
// (`config/redis.ts`, `server.ts`), so this barrel never loads the queue;
// `tenants.console-resolver` by `console/modules/index.ts`.

export * from "./services";
export * from "./tenants.cli";
export { parentOf } from "./tenants.console-parent";
export * from "./tenants.errors";
export { tenantHooks } from "./tenants.hooks";
export { type Tenant, tenants } from "./tenants.model";
export {
  effectiveQuotas,
  PLAN_IDS,
  PLATFORM_RETENTION_DAYS,
  type PlanId,
  planOf,
  type QuotaKey,
  type Quotas,
} from "./tenants.plan";
export { PLATFORM_TENANT_SLUG, slugProblem } from "./tenants.rules";
export { purgeAtOf } from "./tenants.trash";
export type {
  OwnedCollectionPurger,
  PartitionPurger,
  PublicOrigin,
} from "./tenants.types";
export { hostOf, issuerOf, issuerOfHost, partitionOf } from "./tenants.utils";
