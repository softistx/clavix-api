import { createTenantKeys, ensureSigningKey } from "@/keys";
import { createSecretBox } from "@/modules/sign-in-methods/secrets";
import { mongo } from "./db";
import { env } from "./env";
import { parseMasterKeys } from "./master-keys";

// The tenants' signing keys, encrypted with CLAVIX_KEYS_MASTER_KEY. Slice C
// (the OAuth endpoints) signs with `signingKeysFor(tenantId)`; the JWKS route
// serves `jwksFor(tenantId)`. The tenant id is the hex id (`partitionOf`).
// It is one key, or a keyring during a rotation (comma-separated, the first seals).
export const masterKeys = parseMasterKeys(env.CLAVIX_KEYS_MASTER_KEY) as [
  Uint8Array,
  ...Uint8Array[],
];

export const { signingKeysFor, jwksFor } = createTenantKeys({
  db: mongo.db,
  masterKey: masterKeys,
});

/** Seals and opens the tenants' social client secrets, under a subkey of the master key (label `social-secrets`); with a keyring the first seals and every key opens. */
export const secretBox = createSecretBox(masterKeys);

/** A tenant's first (or replacement) key; `TenantsService.create` calls it. */
export const ensureSigningKeyOf = async (tenantId: string): Promise<void> => {
  await ensureSigningKey(signingKeysFor, tenantId);
};
