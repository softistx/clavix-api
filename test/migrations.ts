import { syncMongoRelations } from "@softistx/janus-mongo";
import { syncMongoOAuthPartitioned } from "@softistx/janus-oauth-mongo";
import { getCollection } from "@softistx/mongo";
import { mongo } from "@/config/db";
import { resources, scopes, tenants } from "@/modules/collections";

// A database of its own on the test replica set, for the specs that run
// migrations from scratch (the shared one is migrated once, by test/setup.ts).
// Emptied on each call; the collections and indexes a migration writes exist
// beforehand, as `bun run db:sync` leaves them in production (a transaction
// cannot create a collection).
export async function freshMigrationDb() {
  const db = mongo.db.client.db("clavix-migrations-test");
  if (!db.databaseName.endsWith("-test")) {
    throw new Error(`freshMigrationDb: refusing database ${db.databaseName}`);
  }
  await db.dropDatabase();
  await getCollection(db, tenants).sync();
  await getCollection(db, resources).sync();
  await getCollection(db, scopes).sync();
  await syncMongoOAuthPartitioned(db);
  await syncMongoRelations(db);
  return db;
}
