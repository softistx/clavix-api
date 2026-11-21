import { resealMongoSigningKeys } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import {
  emptySecretResealCounts,
  type SecretResealCounts,
} from "@/modules/sign-in-methods/secrets";
import { secondFactorKeysOf } from "@/modules/users/second-factor-keys";
import {
  emptySecondFactorCounts,
  type ResealSecondFactor,
  resealSecondFactorOf,
  type SecondFactorResealCounts,
} from "./second-factor-reseal";

export interface ResealDeps {
  db: Db;
  /** The keyring: the first key is the one every record ends up sealed under. */
  masterKeys: readonly [Uint8Array, ...Uint8Array[]];
  /** Every tenant partition (hex ids), the suspended and the trashed included. */
  tenantIds: () => Promise<string[]>;
  log?: (message: string) => void;
  /** Seals a partition's TOTP secrets again; janus's `secondFactor.reseal` under the keyring by default. */
  resealSecondFactor?: ResealSecondFactor;
  /**
   * The stores of Clavix's own sealed secrets, each sealing one tenant's
   * envelopes again under the same keyring. Required: a store left out would
   * be a secret lost when the old key is dropped.
   */
  secretStores: Record<SecretStore, ResealSecretStore>;
}

/** Clavix's own sealed stores (`createSecretBox`), by the name of their counts in the report. */
export const SECRET_STORES = [
  "webhookSecrets",
  "connectionSecrets",
  "socialSecrets",
] as const;
export type SecretStore = (typeof SECRET_STORES)[number];

/** Seals one tenant's envelopes of a store again (`resealSecrets` of its service). */
export type ResealSecretStore = (
  tenantId: string,
) => Promise<SecretResealCounts>;

export interface ResealReport {
  tenants: number;
  resealed: number;
  /** Records already under the first key. */
  current: number;
  /** Records changed by someone else meanwhile: run again. */
  skipped: number;
  /** Tenants whose run threw (a record no key of the list opens). */
  failed: number;
  /**
   * The TOTP secrets, sealed again by janus (`secondFactor.reseal`), and what
   * still sits under an older key afterwards: `behind` counts the secrets,
   * `recoveryCodesBehind` the recovery-code hashes (those cannot be hashed
   * again: they keep working while their key is in the keyring, and new ones
   * are hashed under the first key).
   */
  secondFactor: SecondFactorResealCounts & {
    sealed: number;
    behind: number;
    recoveryCodesBehind: number;
  };
  /** The webhook endpoints' signing secrets, the rolled ones included. */
  webhookSecrets: SecretResealCounts;
  /** The client secrets of the enterprise connections. */
  connectionSecrets: SecretResealCounts;
  /** The client secrets of the tenants' social apps (the trash included). */
  socialSecrets: SecretResealCounts;
  /**
   * Why the old master key must stay in the keyring, one line per count
   * (`webhookSecrets.behind: 2`); empty when it may be dropped.
   */
  oldKeyNeededBy: string[];
}

/** The key id of a `v1.<keyId>.<iv>.<ciphertext>` sealed value, or `null` for any other text. */
const sealKeyId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const [version, keyId] = value.split(".");
  return version === "v1" && keyId !== undefined ? keyId : null;
};

/** Counts, after the pass, what the users of one partition still hold under an older key (verification of `secondFactor.reseal`). */
async function countSecondFactorSeals(
  db: Db,
  partition: string,
  firstKeyId: string,
) {
  const out = { sealed: 0, behind: 0, recoveryCodesBehind: 0 };
  const users = db
    .collection<{
      secondFactor?: { secret?: string; recoveryCodes?: string[] } | null;
    }>("partitionedUsers")
    .find(
      { partition, "secondFactor.secret": { $exists: true } },
      {
        projection: {
          "secondFactor.secret": 1,
          "secondFactor.recoveryCodes": 1,
        },
      },
    );
  for await (const user of users) {
    const secretKeyId = sealKeyId(user.secondFactor?.secret);
    if (secretKeyId !== null) {
      out.sealed += 1;
      if (secretKeyId !== firstKeyId) out.behind += 1;
    }
    for (const code of user.secondFactor?.recoveryCodes ?? []) {
      const keyId = sealKeyId(code);
      if (keyId !== null && keyId !== firstKeyId) out.recoveryCodesBehind += 1;
    }
  }
  return out;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const COUNT_FIELDS = [
  "scanned",
  "resealed",
  "current",
  "skipped",
  "unreadable",
] as const;

const RECOVERY_CODES = "secondFactor.recoveryCodesBehind";

/** Every count above 0 that keeps the old master key needed, by its path in the report. */
function pendingCounts(
  report: Omit<ResealReport, "oldKeyNeededBy">,
): [string, number][] {
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
 * Seals again, under the first master key, everything a tenant holds under
 * the keyring, tenant after tenant: the private signing keys
 * (`resealMongoSigningKeys`, one run per partition), the TOTP secrets
 * (janus's `secondFactor.reseal`; `secondFactor.behind` checks none is left)
 * and Clavix's own sealed stores (`secretStores`: webhook secrets, connection
 * and social client secrets, each counted again after its pass as `behind`).
 * Idempotent. A step that throws is logged, counts its tenant as `failed`
 * once, and the other steps and tenants go on. The old key may be dropped
 * only when `oldKeyNeededBy` is empty.
 */
export async function resealAllTenants({
  db,
  masterKeys,
  tenantIds,
  log = (message) => console.warn(message),
  resealSecondFactor,
  secretStores,
}: ResealDeps): Promise<ResealReport> {
  const report: Omit<ResealReport, "oldKeyNeededBy"> = {
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
  const keys = secondFactorKeysOf(masterKeys);
  const [first] = keys;
  const sealAgain = resealSecondFactor ?? resealSecondFactorOf(db, keys);
  for (const partition of await tenantIds()) {
    report.tenants += 1;
    const steps: [string, () => Promise<void>][] = [
      [
        "signing keys",
        async () => {
          const done = await resealMongoSigningKeys(db, {
            encryptionKey: [...masterKeys],
            partition,
          });
          report.resealed += done.resealed;
          report.current += done.current;
          report.skipped += done.skipped;
        },
      ],
      [
        "second factor",
        async () => {
          const run = await sealAgain(partition);
          for (const field of COUNT_FIELDS) {
            report.secondFactor[field] += run[field];
          }
          const seals = await countSecondFactorSeals(db, partition, first.id);
          report.secondFactor.sealed += seals.sealed;
          report.secondFactor.behind += seals.behind;
          report.secondFactor.recoveryCodesBehind += seals.recoveryCodesBehind;
        },
      ],
      ...SECRET_STORES.map((store): [string, () => Promise<void>] => [
        store,
        async () => {
          const run = await secretStores[store](partition);
          for (const field of [...COUNT_FIELDS, "behind"] as const) {
            report[store][field] += run[field];
          }
        },
      ]),
    ];
    let failed = false;
    for (const [what, step] of steps) {
      try {
        await step();
      } catch (error) {
        failed = true;
        log(
          `keys: reseal failed for tenant ${partition} (${what}): ${errorText(error)}`,
        );
      }
    }
    if (failed) report.failed += 1;
  }
  return {
    ...report,
    oldKeyNeededBy: pendingCounts(report).map(
      ([path, count]) => `${path}: ${count}`,
    ),
  };
}

/**
 * The script's exit code: 0 only when nothing is left to reseal or retry, in
 * any store. The recovery codes alone do not fail it (they are hashes, no
 * run can move them): `oldKeyNeededBy` still names them.
 */
export const resealExitCode = (report: ResealReport): number =>
  pendingCounts(report).some(([path]) => path !== RECOVERY_CODES) ? 1 : 0;
