/**
 * A per-tenant counter of the changes made to its published signing keys in
 * this process (insert, promote, retire). The public documents cache
 * (`oauth/public-documents.ts`) puts it in its key, so a rotation here shows
 * at once; a rotation made by another instance, or a retired key reaching its
 * `publishUntil`, shows at the cache's TTL.
 */
export interface KeyGenerations {
  of(tenantId: string): number;
  bump(tenantId: string): void;
}

export function createKeyGenerations(): KeyGenerations {
  const generations = new Map<string, number>();
  return {
    of: (tenantId) => generations.get(tenantId) ?? 0,
    bump: (tenantId) => {
      generations.set(tenantId, (generations.get(tenantId) ?? 0) + 1);
    },
  };
}
