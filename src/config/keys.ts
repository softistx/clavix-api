import { createTenantKeys, ensureSigningKey } from "@/keys";
import { createSecretBox } from "@/modules/sign-in-methods/secrets";
import { mongo } from "./db";
import { env } from "./env";

// The tenants' signing keys, encrypted with CLAVIX_KEYS_MASTER_KEY. Slice C
// (the OAuth endpoints) signs with `signingKeysFor(tenantId)`; the JWKS route
// serves `jwksFor(tenantId)`. The tenant id is the hex id (`partitionOf`).
const masterKey = Buffer.from(env.CLAVIX_KEYS_MASTER_KEY, "base64");

export const { signingKeysFor, jwksFor } = createTenantKeys({
  db: mongo.db,
  masterKey,
});

/** Seals and opens the tenants' social client secrets, under a subkey of the master key (label `social-secrets`). */
export const secretBox = createSecretBox(masterKey);

/** A tenant's first (or replacement) key; `TenantsService.create` calls it. */
export const ensureSigningKeyOf = async (tenantId: string): Promise<void> => {
  await ensureSigningKey(signingKeysFor, tenantId);
};
