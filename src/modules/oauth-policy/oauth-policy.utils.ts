import type { Tenant } from "@/modules/tenants";
import { agentsNeedPushOrProof } from "./oauth-policy.rules";

// `dynamic` on the wire is the enum's name.
export const MODE = {
  OFF: "off",
  RESTRICTED: "restricted",
  OPEN: "open",
} as const;
export const MODE_NAME = {
  off: "OFF",
  restricted: "RESTRICTED",
  open: "OPEN",
} as const;

/** A tenant's OAuth policy as the console shows it. */
export const policyOf = (tenant: Tenant) => ({
  tenantId: tenant._id.toHexString(),
  par: { required: tenant.oauth.par.required },
  dpop: { required: tenant.oauth.dpop.required },
  agents: {
    ...tenant.oauth.agents,
    dynamic: MODE_NAME[tenant.oauth.agents.dynamic],
  },
  agentsNeedPushOrProof: agentsNeedPushOrProof(tenant.oauth),
  version: tenant.version,
});
