import { createAdminEventRecorder } from "@/console/admin-events/recorder";
import { mongo } from "./db";

// Where `ctx.audit` writes: the `adminEvents` collection of the app's database
// (indexes by `db:sync`). Nothing else reaches the collection.
export const adminEventRecorder = createAdminEventRecorder(
  mongo.db.adminEvents,
);
