import {
  enforceRetention,
  type RetentionReport,
} from "@/modules/audit/audit.retention";
import { adminEventReader } from "./admin-events";
import { authEventsService } from "./audit";
import { warn } from "./runtime";
import { tenantsService } from "./tenancy";

/** The daily audit retention over the real stores (D16). */
export const createAuditRetention =
  (now: () => Date) => (): Promise<RetentionReport> =>
    enforceRetention(
      {
        targets: () => tenantsService.retentionTargets(),
        deleteAuthBefore: (tenantId, before) =>
          authEventsService.deleteBefore(tenantId, before),
        deleteAdminBefore: (tenantId, before) =>
          adminEventReader.deleteBefore(tenantId, before),
        log: warn,
      },
      now(),
    );
