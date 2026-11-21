import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const domainsGuards: Guards = {
  "Query.domains": view,
  "Query.domain": view,
  "Mutation.addDomain": edit,
  "Mutation.verifyDomain": edit,
  "Mutation.removeDomain": edit,
  "Mutation.setPrimaryDomain": edit,
};

export const domainsAudits: Audits = {
  "Mutation.addDomain": "domain.add",
  "Mutation.verifyDomain": "domain.verify",
  "Mutation.removeDomain": "domain.remove",
  "Mutation.setPrimaryDomain": "domain.setPrimary",
};
