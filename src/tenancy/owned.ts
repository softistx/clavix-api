import type { AnyCollectionDefinition } from "@softistx/mongo";

// Whether a collection definition declares `tenantId` (spread from
// `tenantField`): it is then tenant-owned and read through `scoped()`.
export const isTenantOwned = (definition: AnyCollectionDefinition) =>
  "tenantId" in definition.schema.shape;

// The tenant-owned collections of a set of definitions, by definition name.
export function tenantOwned(
  definitions: Record<string, AnyCollectionDefinition>,
) {
  return Object.values(definitions).filter(isTenantOwned);
}
