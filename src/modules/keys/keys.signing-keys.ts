import {
  assertSigningKeyStore,
  type Jwks,
  publicJwks,
  type SigningKeyStore,
} from "@softistx/janus-oauth";
import { createMongoSigningKeys } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import type { KeyGenerations } from "./keys.generations";
import { encryptionKeyOf, observed } from "./keys.utils";

export interface TenantKeysOptions {
  db: Db;
  /**
   * 32 bytes: the AES-256-GCM key the private JWKs are encrypted with. A
   * non-empty list is a keyring for a rotation: the first seals, any opens.
   */
  masterKey: Uint8Array | readonly Uint8Array[];
  /** Bumped for a tenant each time one of its keys is inserted, promoted or retired. */
  generations: KeyGenerations;
}

/**
 * The signing keys of each tenant: one janus store per tenant, partitioned by
 * the tenant's id in hex (`partitionOf`), so a tenant's keys are neither
 * listed nor decrypted through another's store. Stores are stateless and kept
 * per tenant only to avoid rebuilding them.
 */
export function createTenantKeys({
  db,
  masterKey,
  generations,
}: TenantKeysOptions) {
  const stores = new Map<string, SigningKeyStore>();

  /** The tenant's store: signing (`findCurrentKey`), rotation and JWKS. */
  function signingKeysFor(tenantId: string): SigningKeyStore {
    if (tenantId === "")
      throw new TypeError("A signing key set needs a tenant id");
    let store = stores.get(tenantId);
    if (store === undefined) {
      store = createMongoSigningKeys(db, {
        encryptionKey: encryptionKeyOf(masterKey),
        partition: tenantId,
      });
      assertSigningKeyStore(store, `signing keys of tenant ${tenantId}`);
      store = observed(store, tenantId, generations);
      stores.set(tenantId, store);
    }
    return store;
  }

  /** The public JWKS of the tenant's issuer at `now`: no private member, nothing decrypted. */
  function jwksFor(tenantId: string, now: Date): Promise<Jwks> {
    return publicJwks(signingKeysFor(tenantId), now);
  }

  return { signingKeysFor, jwksFor };
}

export type TenantKeys = ReturnType<typeof createTenantKeys>;
