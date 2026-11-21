import { AuditService } from "@/modules/audit/audit.service";
import { mongo } from "./db";

/** The real sign-in log. The collection is tenant-owned: only this wiring and its module reach it. */
export const authEventsService = new AuditService(mongo.db.authEvents);
