import { type AnyCollectionDefinition, isTenantOwned } from "@softistx/mongo";

// The tenant-owned collections of a set of definitions, by definition name.
// `isTenantOwned` (the package's) reads `schema.shape`: guards.spec.ts checks
// that every definition has one.
export function tenantOwned(
  definitions: Record<string, AnyCollectionDefinition>,
) {
  return Object.values(definitions).filter((d) => isTenantOwned(d));
}
