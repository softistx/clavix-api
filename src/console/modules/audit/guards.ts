import type { Audits } from "../../audit";
import { type Guards, onPlatform, onTenant } from "../../guard";
import { tenantArg } from "../ids";

// D18: the console's activity is `view` (a viewer reads it); the sign-in log
// holds addresses and users' ids, so it is `edit` (a tenant admin). The
// platform's log is for operators.
export const auditGuards: Guards = {
  "Query.adminEvents": onTenant("view", tenantArg),
  "Query.authEvents": onTenant("edit", tenantArg),
  "Query.platformAdminEvents": onPlatform("view"),
};

// Reads only: no mutation, so nothing to audit.
export const auditAudits: Audits = {};
