import { afterAll } from "bun:test";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";

// Preloaded by `bun test` (bunfig.toml), before any spec imports src/: one
// in-memory MongoDB, a one-node replica set so that transactions work, for the
// whole run. src/config/env.ts then reads its URI as MONGO_URI.
const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
Bun.env["MONGO_URI"] = replSet.getUri("clavix-test");
// Specs never cache through a Redis of the developer's .env: they inject their
// own (the Redis specs start theirs).
delete Bun.env["REDIS_URL"];

// Every collection and its indexes, before any spec (autoSync would create one
// on first use, which a transaction cannot do), then the migrations.
{
  const { mongo } = await import("@/config/db");
  await mongo.sync();
  // The janus OAuth collections (partitioned per tenant) and their indexes.
  const { oauthDb } = await import("@/config/oauth-db");
  const { syncMongoOAuthPartitioned } = await import(
    "@softistx/janus-oauth-mongo"
  );
  await syncMongoOAuthPartitioned(oauthDb);
  // The seed, once for the run (`clearDatabase` keeps what it wrote).
  const { migrate } = await import("@softistx/mongo/migrations");
  const { migrations } = await import("@/migrations");
  await migrate(mongo.db, migrations);
}

afterAll(async () => {
  const { mongo } = await import("@/config/db");
  await mongo.close();
  await replSet.stop();
});
