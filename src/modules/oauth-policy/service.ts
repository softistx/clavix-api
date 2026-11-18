import { OptimisticLockError } from "@softistx/mongo";
import { GraphQLError } from "graphql";
import type { Tenant } from "@/modules/tenants/tenants.model";
import type { TenantsService } from "@/modules/tenants/tenants.service";
import {
  AgentsInputError,
  type AgentsPolicyInput,
  applyAgentsInput,
  sameAgents,
} from "./agents-input";
import type { OAuthPolicy } from "./oauth-policy.schema";

const refusal = (code: string, message: string, status: number) =>
  new GraphQLError(message, { extensions: { code, http: { status } } });

/** The change an admin makes to the policy: a flag left out keeps its value. */
export interface OAuthPolicyInput {
  par?: { required?: boolean | undefined } | undefined;
  dpop?: { required?: boolean | undefined } | undefined;
  agents?: AgentsPolicyInput | null | undefined;
}

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
    if (tenant === undefined) throw refusal("NOT_FOUND", "No such tenant", 404);
    return tenant;
  }

  async update(tenantId: string, input: OAuthPolicyInput): Promise<Tenant> {
    await this.get(tenantId);
    // Checked once, on the stored policy, before any write: a bad value stores nothing.
    const checked = (tenant: Tenant) => {
      try {
        return applyAgentsInput(tenant.oauth.agents, input.agents);
      } catch (error) {
        if (error instanceof AgentsInputError) {
          throw refusal("BAD_USER_INPUT", error.message, 400);
        }
        throw error;
      }
    };
    try {
      return await this.tenants.updateOAuth(tenantId, (tenant) => {
        const next: OAuthPolicy = {
          par: { required: input.par?.required ?? tenant.oauth.par.required },
          dpop: {
            required: input.dpop?.required ?? tenant.oauth.dpop.required,
          },
          agents: checked(tenant),
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
      if (error instanceof OptimisticLockError) {
        throw refusal(
          "CONFLICT",
          "The OAuth policy was changed at the same time; read it and try again",
          409,
        );
      }
      throw error;
    }
  }
}
