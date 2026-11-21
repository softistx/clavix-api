import type { Audits } from "@/console/audit";
import { type Guards, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const clientsGuards: Guards = {
  "Query.clients": view,
  "Query.client": view,
  "Mutation.createClient": edit,
  "Mutation.updateClient": edit,
  "Mutation.rotateClientSecret": edit,
  "Mutation.setClientTokenExchange": edit,
  "Mutation.deleteClient": edit,
};

export const clientsAudits: Audits = {
  "Mutation.createClient": "client.create",
  "Mutation.updateClient": "client.update",
  "Mutation.rotateClientSecret": "client.rotateSecret",
  "Mutation.setClientTokenExchange": "client.tokenExchange.set",
  "Mutation.deleteClient": "client.delete",
};
