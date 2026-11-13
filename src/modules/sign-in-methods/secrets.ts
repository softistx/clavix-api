import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { SealedSecret } from "./sign-in.schema";

/** The purpose label of the subkey: the master key itself never encrypts a social secret. */
const LABEL = "social-secrets";
const VERSION = 1;
const TAG_BYTES = 16;

const derive = (masterKey: Uint8Array, info: string, bytes: number) =>
  Buffer.from(hkdfSync("sha256", masterKey, new Uint8Array(0), info, bytes));

/**
 * Seals the tenants' social client secrets (ADR-0035) under a subkey of the
 * master key (`CLAVIX_KEYS_MASTER_KEY`): HKDF-SHA256, no salt, info
 * `social-secrets`, 32 bytes, then AES-256-GCM with a random 12-byte IV.
 *
 * The envelope is `{ v: 1, kid, iv, ct }`: `kid` names the master key (8 bytes
 * of a second derivation, info `social-secrets/kid`, base64url; it tells
 * nothing about the key), so a master-key rotation (clavix-api#49) finds the
 * envelopes to re-wrap; `ct` is the ciphertext followed by the 16-byte tag.
 * `v`, `kid` and `context` (the tenant and the provider) are authenticated: a
 * sealed secret copied to another tenant's document does not open.
 */
export function createSecretBox(masterKey: Uint8Array) {
  const key = derive(masterKey, LABEL, 32);
  const kid = derive(masterKey, `${LABEL}/kid`, 8).toString("base64url");
  const aad = (context: string) => Buffer.from(`v${VERSION}:${kid}:${context}`);

  return {
    kid,
    seal(plaintext: string, context: string): SealedSecret {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(context));
      const ct = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return {
        v: VERSION,
        kid,
        iv: iv.toString("base64url"),
        ct: ct.toString("base64url"),
      };
    },
    /** Throws when the envelope is of another version or key, or the context or the bytes are wrong. The error never carries the secret. */
    open(sealed: SealedSecret, context: string): string {
      if (sealed.v !== VERSION || sealed.kid !== kid) {
        throw new TypeError("Sealed under another key or version");
      }
      const bytes = Buffer.from(sealed.ct, "base64url");
      if (bytes.length < TAG_BYTES) throw new TypeError("Not a sealed secret");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(sealed.iv, "base64url"),
      );
      decipher.setAAD(aad(context));
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

export type SecretBox = ReturnType<typeof createSecretBox>;

/** What a sealed social secret is bound to. */
export const secretContext = (tenantId: string, provider: string) =>
  `${tenantId}:${provider}`;
