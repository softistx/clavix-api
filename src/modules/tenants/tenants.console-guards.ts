import type { Audits } from "@/console/audit";
import { type Guards, onPlatform, onTenant } from "@/console/guard";
import { tenantArg } from "@/console/modules/ids";

const idOf = (args: Record<string, unknown>) =>
  String(args["id"]).toLowerCase();

export const tenantsGuards: Guards = {
  "Query.tenants": onPlatform("view"),
  "Query.tenant": onTenant("view", idOf),
  "Query.plans": { kind: "signedIn" },
  "Query.usage": onTenant("view", tenantArg),
  "Mutation.createTenant": onPlatform("edit"),
  "Mutation.updateTenant": onTenant("edit", idOf),
  "Mutation.setTenantPlan": onPlatform("edit"),
  "Mutation.suspendTenant": onPlatform("edit"),
  "Mutation.resumeTenant": onPlatform("edit"),
  "Mutation.deleteTenant": onPlatform("edit"),
  "Mutation.restoreTenant": onPlatform("edit"),
};

export const tenantsAudits: Audits = {
  "Mutation.createTenant": "tenant.create",
  "Mutation.updateTenant": "tenant.update",
  "Mutation.setTenantPlan": "tenant.setPlan",
  "Mutation.suspendTenant": "tenant.suspend",
  "Mutation.resumeTenant": "tenant.resume",
  "Mutation.deleteTenant": "tenant.delete",
  "Mutation.restoreTenant": "tenant.restore",
};
