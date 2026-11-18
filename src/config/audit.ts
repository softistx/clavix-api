import { AuthEventsService } from "@/modules/audit/auth-events.service";
import { mongo } from "./db";

/** The real sign-in log. The collection is tenant-owned: only this wiring and its module reach it. */
export const authEventsService = new AuthEventsService(mongo.db.authEvents);
