// Every collection of the app, under the key the Mongo exposes it by
// (its key on `mongo.db`): src/config/db.ts wires this module object. A module
// adds its models here.
export { tenants } from "./tenants/tenants.model";
