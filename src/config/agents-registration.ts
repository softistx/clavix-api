import type { OAuthIssuers } from "@softistx/janus-oauth";
import { createRegisterRoute } from "@/oauth/register-route";
import type {
  MetadataThrottle,
  RegisterThrottle,
} from "@/oauth/register-throttle";
import { withRegistration } from "@/oauth/with-registration";
import { agentClientsService, isMetadataClient } from "./agent-clients";
import { exclusive } from "./exclusive";
import { tenantResolver, tenantsService } from "./tenancy";
import { metadataThrottle, registerThrottle } from "./throttle";
import { usageService } from "./usage";

/**
 * The agents' `/register` over the real stores (`register-route.ts`): the
 * quota is the tenant's `agents` quota (plan and overrides), the throttle the
 * app's Redis one. Wrap the issuers before `withTenantState`.
 */
export function withAgentRegistration<
  T extends Pick<OAuthIssuers, "handle" | "serverFor">,
>(
  issuers: T,
  throttle: RegisterThrottle | undefined = registerThrottle,
  fetchThrottle: MetadataThrottle | undefined = metadataThrottle,
) {
  const agentQuotaOf = async (tenantId: string) => {
    const [tenant] = await tenantsService.liveByIds([tenantId]);
    return tenant === undefined ? 0 : usageService.quotasOf(tenant).agents;
  };
  return withRegistration(issuers, {
    resolver: tenantResolver,
    agents: agentClientsService,
    isMetadataClient,
    register: createRegisterRoute({
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
