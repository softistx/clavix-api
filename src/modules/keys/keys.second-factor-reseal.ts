import { janus, type SealingKey } from "@softistx/janus";
import { createMongoStores } from "@softistx/janus-mongo";
import type { Db } from "mongodb";
import { SESSION, SESSION_COOKIE, userSchema } from "@/modules/users";
import type { ResealSecondFactor } from "./keys.types";
import { emptySecondFactorCounts, sealKeyId } from "./keys.utils";

/** Batch size of the pass (janus's maximum). */
const BATCH = 100;

/**
 * `secondFactor.reseal` of a partition's janus store, looped over its batches
 * (`nextCursor` resumes). The instance is the minimal one the call needs: the
 * partition's stores and the second factor's keys, nothing is served from it.
 */
export const resealSecondFactorOf =
  (db: Db, keys: [SealingKey, ...SealingKey[]]): ResealSecondFactor =>
  async (partition) => {
    const auth = janus({
      user: userSchema,
      email: "email",
      store: createMongoStores(db, { partition }),
      cookie: { name: SESSION_COOKIE, sameSite: "lax", secure: true },
      session: SESSION,
      secondFactor: { issuer: "clavix", keys },
    });
    const total = emptySecondFactorCounts();
    let after: string | null = null;
    do {
      const run = await auth.secondFactor.reseal({ batch: BATCH, after });
      total.scanned += run.scanned;
      total.resealed += run.resealed;
      total.current += run.current;
      total.skipped += run.skipped;
      total.unreadable += run.unreadable;
      after = run.nextCursor;
    } while (after !== null);
    return total;
  };

/** Counts, after the pass, what the users of one partition still hold under an older key (verification of `secondFactor.reseal`). */
export async function countSecondFactorSeals(
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
