import { createHmac } from "node:crypto";

/**
 * janus's sealing key (`secondFactor.keys`), derived from the platform master
 * key by HMAC-SHA-256 under a purpose label, so the master key itself never
 * seals anything else. Rotating the master key changes it: sealed TOTP secrets
 * would stop opening, and none is offered to users.
 */
export const sealingKeyOf = (masterKey: string) => ({
  id: "clavix-1",
  key: createHmac("sha256", Buffer.from(masterKey, "base64"))
    .update("clavix:janus-sealing-key:1")
    .digest("base64"),
});
