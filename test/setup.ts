import { afterAll } from "bun:test";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";

// Preloaded by `bun test` (bunfig.toml), before any spec imports src/: one
// in-memory MongoDB, a one-node replica set so that transactions work, for the
// whole run. src/config/env.ts then reads its URI as MONGO_URI.
const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
  // mongod sizes its cache at half the RAM and, on a loaded laptop, can take
  // longer than the default 10 s to open; a small cache and a longer wait.
  instanceOpts: [
    { args: ["--wiredTigerCacheSizeGB=1"], launchTimeout: 60_000 },
  ],
});
Bun.env["MONGO_URI"] = replSet.getUri("clavix-test");
// Specs never cache through a Redis of the developer's .env: they inject their
// own (the Redis specs start theirs).
delete Bun.env["REDIS_URL"];
// One proxy in front, as in production: specs pick the client address with X-Forwarded-For.
Bun.env["CLAVIX_TRUSTED_PROXIES"] = "1";

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
  // The janus user stores and invitations, partitioned per tenant too.
  const { syncMongoInvitationsPartitioned, syncMongoStoresPartitioned } =
    await import("@softistx/janus-mongo");
  await syncMongoStoresPartitioned(oauthDb);
  // The console's permission tuples (not partitioned).
  const { syncMongoRelations } = await import("@softistx/janus-mongo");
  await syncMongoRelations(oauthDb);
  await syncMongoInvitationsPartitioned(oauthDb);
  // The seed, once for the run (`clearDatabase` keeps what it wrote).
  const { migrate } = await import("@softistx/mongo/migrations");
  const { migrations } = await import("@/migrations");
  await migrate(mongo.db, migrations);
  // The `console-par-dpop` migration makes the `clavix` tenant require PAR and
  // DPoP, as production does. The specs mint plain tokens for it: relax it for
  // the run (the specs of the requirement set it themselves, then restore it).
  const { relaxParAndDpopOnConsole } = await import(
    "@/migrations/2026-11-17-console-par-dpop.migration"
  );
  const { env } = await import("@/config/env");
  await relaxParAndDpopOnConsole(mongo.db, {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    domain: env.CLAVIX_DOMAIN,
    port: env.CLAVIX_PUBLIC_PORT,
  });
}

afterAll(async () => {
  const { mongo } = await import("@/config/db");
  await mongo.close();
  await replSet.stop();
});
