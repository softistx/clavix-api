import { defineMongo, type MongoOf, openMongo } from "@softistx/mongo";
import { MongoClient } from "mongodb";
import * as collections from "@/modules/collections";
import { tenantHooks } from "@/modules/tenants";
import { env } from "./env";

const autoSync = Bun.env.NODE_ENV !== "production";

// The driver client, built from the URI but not connected: the driver opens
// the connection on the first command (or on `connectMongo()`), so importing
// this module, and so the schema, needs no database.
const client = new MongoClient(env.MONGO_URI, {
  // The driver's command events feed the traces (`instrumentDatabase`); off
  // without a collector.
  monitorCommands: env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined,
});

// The app's MongoDB. `autoSync` creates each collection's validator and
// indexes before its first use, in development and tests; in production
// `bun run db:sync` does, as a deployment step (it needs the dbAdmin role).
export const mongoConfig = defineMongo({
  client,
  collections,
  optionsFor: { tenants: { hooks: tenantHooks } },
  autoSync,
});

export type AppMongo = MongoOf<typeof mongoConfig>;

// `openMongo` over an unconnected client does no I/O: it only wires the
// collections, which are built when first read.
export const mongo: AppMongo = await openMongo(mongoConfig);

let connecting: Promise<MongoClient> | undefined;

/**
 * Opens the connection, once (memoised). The server, the scripts and the specs
 * call it where a bad URI must fail at start, as the health check expects; code
 * that never queries (the schema printer) never does.
 */
export const connectMongo = (): Promise<MongoClient> => {
  connecting ??= client.connect();
  return connecting;
};

/** Closes the client (`app.onStop`, scripts, specs); a no-op if never connected. */
export const closeMongo = async (): Promise<void> => {
  await client.close();
};
