import { janus, type SealingKey } from "@softistx/janus";
import { createMongoStores } from "@softistx/janus-mongo";
import type { Db } from "mongodb";
import { SESSION, SESSION_COOKIE } from "@/users/tenant-janus";
import { userSchema } from "@/users/user";

/** What one tenant's pass over the TOTP secrets did (janus's `secondFactor.reseal`, summed over its batches). */
export interface SecondFactorResealCounts {
  scanned: number;
  resealed: number;
  current: number;
  /** Changed meanwhile: run again. */
  skipped: number;
  /** No key of the keyring opens them: left as they are. */
  unreadable: number;
}

export const emptySecondFactorCounts = (): SecondFactorResealCounts => ({
  scanned: 0,
  resealed: 0,
  current: 0,
  skipped: 0,
  unreadable: 0,
});

/** Seals one partition's TOTP secrets again; the whole pass, batch after batch. */
export type ResealSecondFactor = (
  partition: string,
) => Promise<SecondFactorResealCounts>;

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
