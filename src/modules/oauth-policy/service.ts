import { OptimisticLockError } from "@softistx/mongo";
import { GraphQLError } from "graphql";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import type { Tenant } from "@/modules/tenants/tenants.model";
import type { TenantsService } from "@/modules/tenants/tenants.service";
import type { OAuthPolicy } from "./oauth-policy.schema";

const refusal = (code: string, message: string, status: number) =>
  new GraphQLError(message, { extensions: { code, http: { status } } });

/** The change an admin makes to the policy: a flag left out keeps its value. */
export interface OAuthPolicyInput {
  par?: { required?: boolean | undefined } | undefined;
  dpop?: { required?: boolean | undefined } | undefined;
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
    try {
      return await this.tenants.updateOAuth(tenantId, (tenant) => {
        const next: OAuthPolicy = {
          par: { required: input.par?.required ?? tenant.oauth.par.required },
          dpop: {
            required: input.dpop?.required ?? tenant.oauth.dpop.required,
          },
        };
        if (
          next.par.required === tenant.oauth.par.required &&
          next.dpop.required === tenant.oauth.dpop.required
        ) {
          return null;
        }
        // The console signs in with a client that does not push yet (ADR in
        // the M3 plan, decision 2): requiring it would lock every operator out.
        if (
          tenant.slug === PLATFORM_TENANT_SLUG &&
          (next.par.required || next.dpop.required)
        ) {
          throw refusal(
            "PLATFORM_TENANT_PROTECTED",
            "The platform tenant cannot require pushed authorization requests or DPoP yet",
            409,
          );
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
