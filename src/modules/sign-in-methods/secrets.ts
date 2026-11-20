import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { SealedSecret } from "./sign-in.schema";

/** The purpose label of the subkey by default: the master key itself never encrypts a social secret. */
const SOCIAL_LABEL = "social-secrets";
const VERSION = 1;
const TAG_BYTES = 16;

const derive = (masterKey: Uint8Array, info: string, bytes: number) =>
  Buffer.from(hkdfSync("sha256", masterKey, new Uint8Array(0), info, bytes));

/**
 * Seals the tenants' social client secrets (ADR-0035) under a subkey of the
 * master key (`CLAVIX_KEYS_MASTER_KEY`): HKDF-SHA256, no salt, info
 * `social-secrets`, 32 bytes, then AES-256-GCM with a random 12-byte IV.
 *
 * With a keyring (a master-key rotation) the first key seals and every key
 * opens, by the envelope's `kid`. Envelopes under an older key stay readable
 * while it is in the list; `keys:reseal` wraps them again under the first key
 * (`reseal`), and the old key leaves the list only after a clean report.
 *
 * The envelope is `{ v: 1, kid, iv, ct }`: `kid` names the master key (8 bytes
 * of a second derivation, info `social-secrets/kid`, base64url; it tells
 * nothing about the key), so a master-key rotation (`keys:reseal`) finds the
 * envelopes to re-wrap; `ct` is the ciphertext followed by the 16-byte tag.
 * `v`, `kid` and `context` (the tenant and the provider) are authenticated: a
 * sealed secret copied to another tenant's document does not open.
 */
export function createSecretBox(
  masterKeys: Uint8Array | readonly [Uint8Array, ...Uint8Array[]],
  /** The purpose of the subkey: another label seals another kind of secret (the webhook secrets), under a key the others cannot open. */
  label: string = SOCIAL_LABEL,
) {
  const ring = masterKeys instanceof Uint8Array ? [masterKeys] : masterKeys;
  const keys = ring.map((masterKey) => {
    const kid = derive(masterKey, `${label}/kid`, 8).toString("base64url");
    return { kid, key: derive(masterKey, label, 32) };
  });
  const [current] = keys;
  if (current === undefined) throw new TypeError("A secret box needs a key");
  const aad = (kid: string, context: string) =>
    Buffer.from(`v${VERSION}:${kid}:${context}`);

  const seal = (plaintext: string, context: string): SealedSecret => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", current.key, iv);
    cipher.setAAD(aad(current.kid, context));
    const ct = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      v: VERSION,
      kid: current.kid,
      iv: iv.toString("base64url"),
      ct: ct.toString("base64url"),
    };
  };
  const open = (sealed: SealedSecret, context: string): string => {
    const entry = keys.find((candidate) => candidate.kid === sealed.kid);
    if (sealed.v !== VERSION || entry === undefined) {
      throw new TypeError("Sealed under another key or version");
    }
    const bytes = Buffer.from(sealed.ct, "base64url");
    if (bytes.length < TAG_BYTES) throw new TypeError("Not a sealed secret");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      entry.key,
      Buffer.from(sealed.iv, "base64url"),
    );
    decipher.setAAD(aad(entry.kid, context));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  };

  return {
    /** The key that seals. */
    kid: current.kid,
    /** Whether an envelope sealed under `kid` can be opened: its key is in the keyring. */
    opens: (kid: string) => keys.some((entry) => entry.kid === kid),
    seal,
    /** Throws when the envelope is of another version or of a key outside the keyring, or the context or the bytes are wrong. The error never carries the secret. */
    open,
    /**
     * The envelope under the key that seals (a master-key rotation): the same
     * object when it already is, a fresh seal of the opened secret otherwise.
     * Throws as `open` does.
     */
    reseal: (sealed: SealedSecret, context: string): SealedSecret =>
      sealed.kid === current.kid
        ? sealed
        : seal(open(sealed, context), context),
  };
}

export type SecretBox = ReturnType<typeof createSecretBox>;

/** What a sealed social secret is bound to. */
export const secretContext = (tenantId: string, provider: string) =>
  `${tenantId}:${provider}`;

/**
 * What one pass of `keys:reseal` did to a store's envelopes (one tenant, or
 * the sum over the tenants). The old master key may leave the keyring only
 * when `skipped`, `unreadable` and `behind` are 0 in every store.
 */
export interface SecretResealCounts {
  /** The envelopes read. */
  scanned: number;
  /** Sealed again under the first key by this pass. */
  resealed: number;
  /** Already under the first key. */
  current: number;
  /** Changed by someone else meanwhile: run again. */
  skipped: number;
  /** No key of the keyring opens them: left as they are. */
  unreadable: number;
  /** Counted again after the pass: the envelopes still under another key. */
  behind: number;
}

export const emptySecretResealCounts = (): SecretResealCounts => ({
  scanned: 0,
  resealed: 0,
  current: 0,
  skipped: 0,
  unreadable: 0,
  behind: 0,
});
