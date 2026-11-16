import { defineMigration } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";

export const id = "2026-11-16-name-keys";

const COLLECTION = "partitionedUsers";

/** The key `@softistx/janus` 0.66 writes for a display name (NFKC, lowercase, white space collapsed, 128 characters). */
export const nameKeyOf = (name: string): string =>
  Array.from(name.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim())
    .slice(0, 128)
    .join("");

/**
 * janus-mongo 0.29 searches `list({ namePrefix })` on `nameKey`, which janus
 * 0.66 writes with every user. Users written before have none: this folds
 * their `fields.name` once (janus-mongo's "Backfilling name keys"). It moves
 * neither `version` nor `updatedAt`, so no concurrent write is refused.
 * Idempotent: a user with a key, or without a name, is left alone. Returns how
 * many users it keyed.
 */
export async function backfillNameKeys(db: Db): Promise<number> {
  const users = db.collection(COLLECTION);
  let keyed = 0;
  for await (const user of users.find({
    nameKey: { $exists: false },
    "fields.name": { $type: "string" },
  })) {
    const nameKey = nameKeyOf(String(user["fields"].name));
    if (nameKey === "") continue;
    await users.updateOne({ _id: user._id }, { $set: { nameKey } });
    keyed += 1;
  }
  return keyed;
}

// Needs `db:sync` first (the validator refuses `nameKey` until it runs).
// Down changes nothing: the key is derived data the core keeps current.
export const nameKeysMigration = defineMigration({
  id,
  async up({ db }) {
    await backfillNameKeys(db);
  },
  async down() {},
});
