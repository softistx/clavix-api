import { createTenantKeys, ensureSigningKey } from "@/keys";
import { mongo } from "./db";
import { env } from "./env";

// The tenants' signing keys, encrypted with CLAVIX_KEYS_MASTER_KEY. Slice C
// (the OAuth endpoints) signs with `signingKeysFor(tenantId)`; the JWKS route
// serves `jwksFor(tenantId)`. The tenant id is the hex id (`partitionOf`).
export const { signingKeysFor, jwksFor } = createTenantKeys({
  db: mongo.db,
  masterKey: Buffer.from(env.CLAVIX_KEYS_MASTER_KEY, "base64"),
});

/** A tenant's first (or replacement) key; `TenantsService.create` calls it. */
export const ensureSigningKeyOf = async (tenantId: string): Promise<void> => {
  await ensureSigningKey(signingKeysFor, tenantId);
};
