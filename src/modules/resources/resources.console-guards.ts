import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const resourcesGuards: Guards = {
  "Query.resources": view,
  "Query.resource": view,
  "Query.scopes": view,
  "Mutation.createResource": edit,
  "Mutation.updateResource": edit,
  "Mutation.deleteResource": edit,
  "Mutation.createScope": edit,
  "Mutation.updateScope": edit,
  "Mutation.deleteScope": edit,
  "Mutation.createDetailType": edit,
  "Mutation.updateDetailType": edit,
  "Mutation.deleteDetailType": edit,
};

export const resourcesAudits: Audits = {
  "Mutation.createResource": "resource.create",
  "Mutation.updateResource": "resource.update",
  "Mutation.deleteResource": "resource.delete",
  "Mutation.createScope": "scope.create",
  "Mutation.updateScope": "scope.update",
  "Mutation.deleteScope": "scope.delete",
  "Mutation.createDetailType": "detailType.create",
  "Mutation.updateDetailType": "detailType.update",
  "Mutation.deleteDetailType": "detailType.delete",
};
