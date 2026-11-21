import type { OAuthIssuers } from "@softistx/janus-oauth";
import { createRegisterRoute } from "@/oauth/register-route";
import type {
  MetadataThrottle,
  RegisterThrottle,
} from "@/oauth/register-throttle";
import { withRegistration } from "@/oauth/with-registration";
import { agentClientsService, isMetadataClient } from "./agent-clients";
import { exclusive } from "./exclusive";
import { warn } from "./runtime";
import { tenantResolver, tenantsService } from "./tenancy";
import { usageService } from "./usage";

/**
 * The agents' `/register` over the real stores (`register-route.ts`): the
 * quota is the tenant's `agents` quota (plan and overrides), the throttles the
 * app's Redis ones (`noThrottle` without it). Wrap the issuers before `withTenantState`.
 */
export function withAgentRegistration<
  T extends Pick<OAuthIssuers, "handle" | "serverFor">,
>(issuers: T, throttle: RegisterThrottle, fetchThrottle: MetadataThrottle) {
  const agentQuotaOf = async (tenantId: string) => {
    const [tenant] = await tenantsService.liveByIds([tenantId]);
    return tenant === undefined ? 0 : usageService.quotasOf(tenant).agents;
  };
  return withRegistration(issuers, {
    log: warn,
    resolver: tenantResolver,
    agents: agentClientsService,
    isMetadataClient,
    register: createRegisterRoute({
      log: warn,
      resolver: tenantResolver,
      serverFor: issuers.serverFor,
      throttle,
      agents: agentClientsService,
      agentQuotaOf,
      exclusive,
    }),
    throttle: fetchThrottle,
    agentQuotaOf,
    exclusive,
  });
}
