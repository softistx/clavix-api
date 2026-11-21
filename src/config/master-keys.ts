import { isNonEmpty } from "@/shared/values";

/** One master key as written in the environment: 32 bytes in standard base64. */
const ITEM = /^[A-Za-z0-9+/]{43}=$/;

/** What is wrong with a `CLAVIX_KEYS_MASTER_KEY` value, or `undefined` when it is a valid keyring. */
export function masterKeysProblem(value: string): string | undefined {
  const items = value.split(",").map((item) => item.trim());
  for (const item of items) {
    if (!ITEM.test(item) || Buffer.from(item, "base64").length !== 32) {
      return "not 32 bytes in base64 (a keyring is a comma-separated list of them)";
    }
  }
  if (new Set(items).size !== items.length) {
    return "the same key appears twice in the keyring";
  }
  return undefined;
}

/**
 * The master keyring of `CLAVIX_KEYS_MASTER_KEY`: one key, or a comma-separated
 * list during a rotation. The first key seals every new record; any key of the
 * list opens one (`@softistx/janus-oauth-mongo` keyring). Throws a `TypeError`
 * for a malformed value; the environment is checked at boot, so this only
 * decodes.
 */
export function parseMasterKeys(value: string): [Uint8Array, ...Uint8Array[]] {
  const problem = masterKeysProblem(value);
  if (problem !== undefined)
    throw new TypeError(`CLAVIX_KEYS_MASTER_KEY: ${problem}`);
  const keys = value
    .split(",")
    .map((item) => Buffer.from(item.trim(), "base64"));
  if (!isNonEmpty(keys)) throw new TypeError("CLAVIX_KEYS_MASTER_KEY: no key");
  return keys;
}
