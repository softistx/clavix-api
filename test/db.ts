import { mongo } from "@/config/db";

// The collections `clearDatabase` keeps: the migrations' own records.
export const keptCollectionNames: readonly string[] = [
  "nxgt_migrations",
  "nxgt_migrations_lock",
];

// Empties every collection of the test database but the kept ones, keeping its
// indexes and validators: what a spec calls in `beforeEach` when it counts or
// lists. It refuses any database whose name does not end in "-test".
export async function clearDatabase() {
  const { db } = mongo;
  if (!db.databaseName.endsWith("-test")) {
    throw new Error(`clearDatabase: refusing database ${db.databaseName}`);
  }
  const collections = await db.collections();
  await Promise.all(
    collections
      .filter((c) => !keptCollectionNames.includes(c.collectionName))
      .map((c) => c.deleteMany({})),
  );
}
