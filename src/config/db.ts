import { defineMongo, type MongoOf, openMongo } from "@softistx/mongo";
import * as collections from "@/modules/collections";
import { tenantHooks } from "@/modules/tenants";
import { env } from "./env";

const autoSync = Bun.env.NODE_ENV !== "production";

// The app's MongoDB. `autoSync` creates each collection's validator and
// indexes before its first use, in development and tests; in production
// `bun run db:sync` does, as a deployment step (it needs the dbAdmin role).
export const mongoConfig = defineMongo({
  uri: env.MONGO_URI,
  collections,
  optionsFor: { tenants: { hooks: tenantHooks } },
  autoSync,
  // The driver's command events feed the traces (`instrumentDatabase`); off
  // without a collector.
  clientOptions: {
    monitorCommands: env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined,
  },
});

export type AppMongo = MongoOf<typeof mongoConfig>;

// Opened once, when this module is first imported; `app.onStop` closes it.
export const mongo: AppMongo = await openMongo(mongoConfig);
