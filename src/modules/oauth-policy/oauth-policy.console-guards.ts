import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

export const oauthPolicyGuards: Guards = {
  "Query.oauthPolicy": onTenant("view", tenantArg),
  "Mutation.updateOAuthPolicy": onTenant("edit", tenantArg),
};

/** The audit action of each mutation (audit.spec.ts). */
export const oauthPolicyAudits: Audits = {
  "Mutation.updateOAuthPolicy": "oauthPolicy.update",
};
