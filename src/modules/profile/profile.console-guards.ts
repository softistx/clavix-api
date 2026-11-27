import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

// Reading the locks is `view`; changing them is `edit`.
export const profileGuards: Guards = {
  "Query.profilePolicy": onTenant("view", tenantArg),
  "Mutation.updateProfilePolicy": onTenant("edit", tenantArg),
};

// One event per change, once it is stored; a repeat records again. Ids only.
export const profileAudits: Audits = {
  "Mutation.updateProfilePolicy": "profilePolicy.update",
};
