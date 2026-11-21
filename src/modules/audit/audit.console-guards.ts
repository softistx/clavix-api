import type { Audits } from "@/console/audit";
import { type Guards, onPlatform, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

// D18: the console's activity is `view` (a viewer reads it); the sign-in log
// holds addresses and users' ids, so it is `edit` (a tenant admin). The
// platform's log is for operators.
export const auditGuards: Guards = {
  "Query.adminEvents": onTenant("view", tenantArg),
  "Query.authEvents": onTenant("edit", tenantArg),
  "Query.adminEvent": onTenant("view", tenantArg),
  "Query.authEvent": onTenant("edit", tenantArg),
  "Query.platformAdminEvents": onPlatform("view"),
  "Query.platformAdminEvent": onPlatform("view"),
};

// Reads only: no mutation, so nothing to audit.
export const auditAudits: Audits = {};
