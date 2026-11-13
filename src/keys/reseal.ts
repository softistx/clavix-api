import { resealMongoSigningKeys } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";

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
}

/**
 * Re-seals the private signing keys of every tenant under the first master key
 * (`resealMongoSigningKeys`, one run per partition). Idempotent. A tenant that
 * fails is logged and the others go on. The rotation is over when a run
 * answers `resealed: 0`, `skipped: 0`, `failed: 0`.
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
  };
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
