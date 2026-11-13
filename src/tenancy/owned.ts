import { type AnyCollectionDefinition, isTenantOwned } from "@softistx/mongo";

// Collections with a `tenantId` that no tenant owns: the field says which
// tenant an entry is about (`null`: the platform), and only platform code
// reads or writes them, across tenants. `adminEvents` is the console's record
// (ADR-0037), reached through its recorder alone (src/console/audit.spec.ts).
// A name is added here by a decision, never to get a guard out of the way.
export const platformCollections: readonly string[] = ["adminEvents"];

/** Whether a tenant owns the definition's documents (so the guards apply). */
export const isOwned = (definition: AnyCollectionDefinition) =>
  isTenantOwned(definition) && !platformCollections.includes(definition.name);

// The tenant-owned collections of a set of definitions, by definition name.
// `isTenantOwned` (the package's) reads `schema.shape`: guards.spec.ts checks
// that every definition has one.
export function tenantOwned(
  definitions: Record<string, AnyCollectionDefinition>,
) {
  return Object.values(definitions).filter(isOwned);
}
