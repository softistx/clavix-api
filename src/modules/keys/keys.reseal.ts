import { resealMongoSigningKeys } from "@softistx/janus-oauth-mongo";
import { secondFactorKeysOf } from "@/modules/users";
import { countSecondFactorSeals } from "./keys.second-factor-reseal";
import {
  type ResealCounts,
  type ResealDeps,
  type ResealReport,
  type ResealSecondFactor,
  SECRET_STORES,
  type SecretStore,
} from "./keys.types";
import {
  COUNT_FIELDS,
  emptyResealCounts,
  errorText,
  pendingCounts,
} from "./keys.utils";

type Step = [string, () => Promise<void>];

/** Seals the tenant's private signing keys again, under the first master key. */
const signingKeysStep =
  (
    report: ResealCounts,
    partition: string,
    { db, masterKeys }: ResealDeps,
  ): (() => Promise<void>) =>
  async () => {
    const done = await resealMongoSigningKeys(db, {
      encryptionKey: [...masterKeys],
      partition,
    });
    report.resealed += done.resealed;
    report.current += done.current;
    report.skipped += done.skipped;
  };

/** Seals the tenant's TOTP secrets again, then counts the seals left behind. */
const secondFactorStep =
  (
    report: ResealCounts,
    partition: string,
    { db }: ResealDeps,
    sealAgain: ResealSecondFactor,
    firstKeyId: string,
  ): (() => Promise<void>) =>
  async () => {
    const run = await sealAgain(partition);
    for (const field of COUNT_FIELDS) {
      report.secondFactor[field] += run[field];
    }
    const seals = await countSecondFactorSeals(db, partition, firstKeyId);
    report.secondFactor.sealed += seals.sealed;
    report.secondFactor.behind += seals.behind;
    report.secondFactor.recoveryCodesBehind += seals.recoveryCodesBehind;
  };

/** Seals one of Clavix's own secret stores again for the tenant. */
const secretStoreStep =
  (
    report: ResealCounts,
    partition: string,
    { secretStores }: ResealDeps,
    store: SecretStore,
  ): (() => Promise<void>) =>
  async () => {
    const run = await secretStores[store](partition);
    for (const field of [...COUNT_FIELDS, "behind"] as const) {
      report[store][field] += run[field];
    }
  };

/** The steps of one tenant: its signing keys, its TOTP secrets, each sealed store. */
function stepsOf(
  report: ResealCounts,
  partition: string,
  deps: ResealDeps,
  sealAgain: ResealSecondFactor,
  firstKeyId: string,
): Step[] {
  return [
    ["signing keys", signingKeysStep(report, partition, deps)],
    [
      "second factor",
      secondFactorStep(report, partition, deps, sealAgain, firstKeyId),
    ],
    ...SECRET_STORES.map(
      (store: SecretStore): Step => [
        store,
        secretStoreStep(report, partition, deps, store),
      ],
    ),
  ];
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
export async function resealAllTenants(
  deps: ResealDeps,
): Promise<ResealReport> {
  const { masterKeys, tenantIds, log, resealSecondFactor } = deps;
  const report = emptyResealCounts();
  const keys = secondFactorKeysOf(masterKeys);
  const [first] = keys;
  for (const partition of await tenantIds()) {
    report.tenants += 1;
    let failed = false;
    for (const [what, step] of stepsOf(
      report,
      partition,
      deps,
      resealSecondFactor,
      first.id,
    )) {
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
