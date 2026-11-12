import { mongo } from "./db";

// The plain driver `Db` of the app's database, for the janus OAuth adapters
// (`@softistx/janus-oauth-mongo`). They do not go through the scoped
// collections: each partitions itself by the tenant's id (ADR-0006), so this
// handle is allowed outside src/tenancy (see the source scan in
// src/tenancy/guards.spec.ts).
export const oauthDb = mongo.clients.default.db(mongo.db.databaseName);
