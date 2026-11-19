import { resealMongoSigningKeys } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import { secondFactorKeysOf } from "@/users/second-factor-keys";

export interface ResealDeps {
  db: Db;
  /** The keyring: the first key is the one every record ends up sealed under. */
  masterKeys: readonly [Uint8Array, ...Uint8Array[]];
  /** Every tenant partition (hex ids), the suspended and the trashed included. */
  tenantIds: () => Promise<string[]>;
  log?: (message: string) => void;
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
   * The TOTP secrets and recovery codes sealed under a key of the keyring, to
   * report, never to act on: janus has no re-seal call for them, a secret
   * moves under the first key on its user's next accepted code.
   */
  secondFactor: { sealed: number; behind: number };
}

/** The key id of a `v1.<keyId>.<iv>.<ciphertext>` sealed value, or `null` for any other text. */
const sealKeyId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const [version, keyId] = value.split(".");
  return version === "v1" && keyId !== undefined ? keyId : null;
};

/** Counts what the users of one partition hold sealed for the second factor, by whether it is under the first key. */
async function countSecondFactorSeals(
  db: Db,
  partition: string,
  firstKeyId: string,
) {
  const out = { sealed: 0, behind: 0 };
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
    for (const value of [
      user.secondFactor?.secret,
      ...(user.secondFactor?.recoveryCodes ?? []),
    ]) {
      const keyId = sealKeyId(value);
      if (keyId === null) continue;
      out.sealed += 1;
      if (keyId !== firstKeyId) out.behind += 1;
    }
  }
  return out;
}

/**
 * Re-seals the private signing keys of every tenant under the first master key
 * (`resealMongoSigningKeys`, one run per partition). Idempotent. A tenant that
 * fails is logged and the others go on. The rotation is over when a run
 * answers `resealed: 0`, `skipped: 0`, `failed: 0`. The second factor's seals
 * are only counted (`secondFactor.behind`): the old key stays in the keyring
 * until that number is 0, or its users re-enrol.
 */
export async function resealAllTenants({
  db,
  masterKeys,
  tenantIds,
  log = (message) => console.warn(message),
}: ResealDeps): Promise<ResealReport> {
  const report: ResealReport = {
    tenants: 0,
    resealed: 0,
    current: 0,
    skipped: 0,
    failed: 0,
    secondFactor: { sealed: 0, behind: 0 },
  };
  const [first] = secondFactorKeysOf([...masterKeys] as [
    Uint8Array,
    ...Uint8Array[],
  ]);
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
      const seals = await countSecondFactorSeals(db, partition, first.id);
      report.secondFactor.sealed += seals.sealed;
      report.secondFactor.behind += seals.behind;
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
  report.skipped > 0 || report.failed > 0 ? 1 : 0;
