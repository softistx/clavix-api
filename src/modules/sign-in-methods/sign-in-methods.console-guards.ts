import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

export const signInMethodsGuards: Guards = {
  "Query.signInPolicy": onTenant("view", tenantArg),
  "Mutation.updateSignInMethods": onTenant("edit", tenantArg),
  "Mutation.setSocialProvider": onTenant("edit", tenantArg),
  "Mutation.removeSocialProvider": onTenant("edit", tenantArg),
  "Mutation.updateMfaPolicy": onTenant("edit", tenantArg),
};

/** The audit action of each mutation (audit.spec.ts). */
export const signInMethodsAudits: Audits = {
  "Mutation.updateSignInMethods": "signInPolicy.update",
  "Mutation.setSocialProvider": "socialProvider.set",
  "Mutation.removeSocialProvider": "socialProvider.remove",
  "Mutation.updateMfaPolicy": "mfaPolicy.update",
};
