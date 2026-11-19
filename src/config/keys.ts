import { hkdfSync } from "node:crypto";
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

/** Seals and opens the webhook endpoints' signing secrets (D19), under its own subkey (label `webhook-secrets`). */
export const webhookSecretBox = createSecretBox(masterKeys, "webhook-secrets");

/** Seals and opens the client secrets of the tenants' enterprise OIDC connections, under their own subkey (label `connection-secrets`). */
export const connectionSecretBox = createSecretBox(
  masterKeys,
  "connection-secrets",
);

/** A tenant's first (or replacement) key; `TenantsService.create` calls it. */
export const ensureSigningKeyOf = async (tenantId: string): Promise<void> => {
  await ensureSigningKey(signingKeysFor, tenantId);
};

/**
 * The secret of the DPoP server nonces (RFC 9449 §8): HKDF-SHA256 of the first
 * master key, no salt, info `dpop-nonce`, 32 bytes, base64url. The nonces are
 * stateless HMACs under it, so every instance derives the same one; rotating
 * the master key (a new first key) only makes clients retry once on
 * `use_dpop_nonce`.
 */
export const dpopNonceSecretOf = (
  keys: readonly [Uint8Array, ...Uint8Array[]],
) =>
  Buffer.from(
    hkdfSync("sha256", keys[0], new Uint8Array(0), "dpop-nonce", 32),
  ).toString("base64url");

export const dpopNonceSecret = dpopNonceSecretOf(masterKeys);
