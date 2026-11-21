import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const connectionsGuards: Guards = {
  "Query.connections": view,
  "Query.connection": view,
  // An outbound request on the admin's behalf: `edit`, not `view`.
  "Query.checkConnection": edit,
  "Mutation.createConnection": edit,
  "Mutation.updateConnection": edit,
  "Mutation.setConnectionSecret": edit,
  "Mutation.deleteConnection": edit,
  "Mutation.addConnectionDomain": edit,
  "Mutation.verifyConnectionDomain": edit,
  "Mutation.removeConnectionDomain": edit,
};

export const connectionsAudits: Audits = {
  "Mutation.createConnection": "connection.create",
  "Mutation.updateConnection": "connection.update",
  "Mutation.setConnectionSecret": "connection.setSecret",
  "Mutation.deleteConnection": "connection.delete",
  "Mutation.addConnectionDomain": "connection.addDomain",
  "Mutation.verifyConnectionDomain": "connection.verifyDomain",
  "Mutation.removeConnectionDomain": "connection.removeDomain",
};
