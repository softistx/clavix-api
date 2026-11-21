import { AdminEventReader } from "@/console/admin-events/reader";
import { createAdminEventRecorder } from "@/console/admin-events/recorder";
import { mongo } from "./db";
import { clock } from "./runtime";

// Where `ctx.audit` writes: the `adminEvents` collection of the app's database
// (indexes by `db:sync`). Nothing else reaches the collection.
export const adminEventRecorder = createAdminEventRecorder(
  mongo.db.adminEvents,
  clock,
);

/** The console's readers of the same collection (the activity log, the retention). */
export const adminEventReader = new AdminEventReader(mongo.db.adminEvents);
