import type { SigningKeyStore } from "@softistx/janus-oauth";
import { emptySecretResealCounts } from "@/modules/sign-in-methods";
import { isNonEmpty } from "@/shared/values";
import type { KeyGenerations } from "./keys.generations";
import {
  type ResealCounts,
  type ResealReport,
  SECRET_STORES,
  type SecondFactorResealCounts,
} from "./keys.types";

/** The key, or the keyring, as the signing-key store takes it: a lone key as is, a list as a non-empty tuple. */
export const encryptionKeyOf = (key: Uint8Array | readonly Uint8Array[]) => {
  if (key instanceof Uint8Array) return key;
  const keys = [...key];
  if (!isNonEmpty(keys)) throw new TypeError("The keyring holds no key");
  return keys;
};

/** The store with every write that changes the published set counted. */
export function observed(
  store: SigningKeyStore,
  tenantId: string,
  generations: KeyGenerations,
): SigningKeyStore {
  const counted =
    <A extends unknown[]>(write: (...args: A) => Promise<boolean>) =>
    async (...args: A) => {
      const changed = await write(...args);
      if (changed) generations.bump(tenantId);
      return changed;
    };
  return {
    findKeys: (now) => store.findKeys(now),
    findCurrentKey: (now) => store.findCurrentKey(now),
    findPublicKeys: (now) => store.findPublicKeys(now),
    insertKey: counted((key) => store.insertKey(key)),
    promote: counted((kid, at, until) => store.promote(kid, at, until)),
    retire: counted((kid, at, until) => store.retire(kid, at, until)),
  };
}

/** The message of a thrown value, for the log. */
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The key id of a `v1.<keyId>.<iv>.<ciphertext>` sealed value, or `null` for any other text. */
export const sealKeyId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const [version, keyId] = value.split(".");
  return version === "v1" && keyId !== undefined ? keyId : null;
};

/** The counts of one reseal step that add up across tenants. */
export const COUNT_FIELDS = [
  "scanned",
  "resealed",
  "current",
  "skipped",
  "unreadable",
] as const;

/** The report path of the recovery-code hashes still under an older key. */
export const RECOVERY_CODES = "secondFactor.recoveryCodesBehind";

/** The counts of a TOTP pass at 0. */
export const emptySecondFactorCounts = (): SecondFactorResealCounts => ({
  scanned: 0,
  resealed: 0,
  current: 0,
  skipped: 0,
  unreadable: 0,
});

/** A report with every count at 0, before the first tenant. */
export function emptyResealCounts(): ResealCounts {
  return {
    tenants: 0,
    resealed: 0,
    current: 0,
    skipped: 0,
    failed: 0,
    secondFactor: {
      ...emptySecondFactorCounts(),
      sealed: 0,
      behind: 0,
      recoveryCodesBehind: 0,
    },
    webhookSecrets: emptySecretResealCounts(),
    connectionSecrets: emptySecretResealCounts(),
    socialSecrets: emptySecretResealCounts(),
  };
}

/** Every count above 0 that keeps the old master key needed, by its path in the report. */
export function pendingCounts(report: ResealCounts): [string, number][] {
  const counts: [string, number][] = [
    ["skipped", report.skipped],
    ["failed", report.failed],
    ["secondFactor.skipped", report.secondFactor.skipped],
    ["secondFactor.unreadable", report.secondFactor.unreadable],
    ["secondFactor.behind", report.secondFactor.behind],
    [RECOVERY_CODES, report.secondFactor.recoveryCodesBehind],
    ...SECRET_STORES.flatMap((store): [string, number][] => [
      [`${store}.skipped`, report[store].skipped],
      [`${store}.unreadable`, report[store].unreadable],
      [`${store}.behind`, report[store].behind],
    ]),
  ];
  return counts.filter(([, count]) => count > 0);
}

/**
 * The script's exit code: 0 only when nothing is left to reseal or retry, in
 * any store. The recovery codes alone do not fail it (they are hashes, no
 * run can move them): `oldKeyNeededBy` still names them.
 */
export const resealExitCode = (report: ResealReport): number =>
  pendingCounts(report).some(([path]) => path !== RECOVERY_CODES) ? 1 : 0;
