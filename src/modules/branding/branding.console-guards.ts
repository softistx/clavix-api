import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

export const brandingGuards: Guards = {
  "Query.branding": onTenant("view", tenantArg),
  "Mutation.updateBranding": onTenant("edit", tenantArg),
};

export const brandingAudits: Audits = {
  "Mutation.updateBranding": "branding.update",
};
