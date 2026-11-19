import { resealMongoSigningKeys } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import { secondFactorKeysOf } from "@/users/second-factor-keys";
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
}

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

/**
 * Re-seals the private signing keys of every tenant under the first master key
 * (`resealMongoSigningKeys`, one run per partition). Idempotent. A tenant that
 * fails is logged and the others go on. The rotation is over when a run
 * answers `resealed: 0`, `skipped: 0`, `failed: 0` (`secondFactor.resealed`,
 * `skipped` and `unreadable` included). The TOTP secrets are sealed again by
 * janus's `secondFactor.reseal`; `secondFactor.behind` checks none is left.
 */
export async function resealAllTenants({
  db,
  masterKeys,
  tenantIds,
  log = (message) => console.warn(message),
  resealSecondFactor,
}: ResealDeps): Promise<ResealReport> {
  const report: ResealReport = {
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
  };
  const keys = secondFactorKeysOf(masterKeys);
  const [first] = keys;
  const sealAgain = resealSecondFactor ?? resealSecondFactorOf(db, keys);
  for (const partition of await tenantIds()) {
    report.tenants += 1;
    try {
      const done = await resealMongoSigningKeys(db, {
        encryptionKey: [...masterKeys],
        partition,
      });
      report.resealed += done.resealed;
      report.current += done.current;
      report.skipped += done.skipped;
      const run = await sealAgain(partition);
      for (const field of [
        "scanned",
        "resealed",
        "current",
        "skipped",
        "unreadable",
      ] as const) {
        report.secondFactor[field] += run[field];
      }
      const seals = await countSecondFactorSeals(db, partition, first.id);
      report.secondFactor.sealed += seals.sealed;
      report.secondFactor.behind += seals.behind;
      report.secondFactor.recoveryCodesBehind += seals.recoveryCodesBehind;
    } catch (error) {
      report.failed += 1;
      log(
        `keys: reseal failed for tenant ${partition}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return report;
}

/** The script's exit code: 0 only when nothing is left to reseal or retry. */
export const resealExitCode = (report: ResealReport): number =>
  report.skipped > 0 ||
  report.failed > 0 ||
  report.secondFactor.skipped > 0 ||
  report.secondFactor.unreadable > 0
    ? 1
    : 0;
