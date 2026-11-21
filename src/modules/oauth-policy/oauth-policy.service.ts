import { OptimisticLockError } from "@softistx/mongo";
import type { Tenant, TenantsService } from "@/modules/tenants";
import {
  badAgentsInput,
  policyConflict,
  tenantNotFound,
} from "./oauth-policy.errors";
import {
  AgentsInputError,
  applyAgentsInput,
  sameAgents,
} from "./oauth-policy.rules";
import type { AgentsPolicy, OAuthPolicy } from "./oauth-policy.schema";
import type { OAuthPolicyInput } from "./oauth-policy.types";

/**
 * The OAuth policy of a tenant (M3). Every change is one tenant write: it
 * bumps the tenant's version, so the resolver cache drops the host and the
 * tenant's janus server is rebuilt. A change that changes nothing writes
 * nothing (idempotent).
 */
export class OAuthPolicyService {
  constructor(private readonly tenants: TenantsService) {}

  /** The tenant (suspended included: its policy stays readable), or NOT_FOUND (404) for an unknown or trashed one. */
  async get(tenantId: string): Promise<Tenant> {
    const [tenant] = await this.tenants.liveByIds([tenantId]);
    if (tenant === undefined) throw tenantNotFound();
    return tenant;
  }

  async update(tenantId: string, input: OAuthPolicyInput): Promise<Tenant> {
    await this.get(tenantId);
    try {
      return await this.tenants.updateOAuth(tenantId, (tenant) => {
        const next: OAuthPolicy = {
          par: { required: input.par?.required ?? tenant.oauth.par.required },
          dpop: {
            required: input.dpop?.required ?? tenant.oauth.dpop.required,
          },
          // Checked once, on the stored policy, before any write: a bad value stores nothing.
          agents: this.checkedAgents(tenant.oauth.agents, input),
        };
        if (
          next.par.required === tenant.oauth.par.required &&
          next.dpop.required === tenant.oauth.dpop.required &&
          sameAgents(next.agents, tenant.oauth.agents)
        ) {
          return null;
        }
        return next;
      });
    } catch (error) {
      if (error instanceof OptimisticLockError) throw policyConflict();
      throw error;
    }
  }

  private checkedAgents(
    current: AgentsPolicy,
    input: OAuthPolicyInput,
  ): AgentsPolicy {
    try {
      return applyAgentsInput(current, input.agents);
    } catch (error) {
      if (error instanceof AgentsInputError) {
        throw badAgentsInput(error.message);
      }
      throw error;
    }
  }
}
