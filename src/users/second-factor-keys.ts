import { hkdfSync, randomBytes } from "node:crypto";
import type { SealingKey } from "@softistx/janus";

/** The purpose labels of the subkeys: the master key itself never seals a TOTP secret. */
const LABEL = "second-factor";

const derive = (masterKey: Uint8Array, info: string, bytes: number) =>
  Buffer.from(hkdfSync("sha256", masterKey, new Uint8Array(0), info, bytes));

/**
 * janus's sealing keys for the TOTP secrets and the recovery codes (D8), one
 * per master key of the keyring, in its order (the first seals, every key
 * opens). Each is HKDF-SHA256 of the master key (no salt, info `second-factor`,
 * 32 bytes); its id is 8 other bytes of the same master key (info
 * `second-factor/kid`, base64url), so an id tells nothing about the key and
 * the same keyring gives the same ids on every instance. A master-key
 * rotation is then the keyring's: a new first key seals from the next accepted
 * code on, and `keys:reseal` counts what still sits under an older one.
 */
export function secondFactorKeysOf(
  masterKeys: readonly [Uint8Array, ...Uint8Array[]],
): [SealingKey, ...SealingKey[]] {
  const [first, ...rest] = masterKeys.map((masterKey) => ({
    id: derive(masterKey, `${LABEL}/kid`, 8).toString("base64url"),
    key: derive(masterKey, LABEL, 32).toString("base64"),
  }));
  if (first === undefined) throw new TypeError("A keyring needs a key");
  return [first, ...rest];
}

/**
 * Keys that live and die with the process: what a janus built without the
 * keyring gets (a spec), never the server's. A secret sealed under them opens
 * nowhere else.
 */
export const ephemeralSecondFactorKeys = (): [SealingKey, ...SealingKey[]] =>
  secondFactorKeysOf([randomBytes(32)]);
