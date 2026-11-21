import type { SealingKey, UserEventListener } from "@softistx/janus";
import { createJanusIssuers } from "@softistx/janus";
import type { Db } from "mongodb";
import type { SecretBox } from "@/modules/sign-in-methods";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { fingerprintOf } from "./users.rp";
import type { ConnectionsOf } from "./users.social";
import {
  buildTenantJanus,
  type InvitationHooksFor,
} from "./users.tenant-janus";

export interface TenantJanusOptions {
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus collections (`syncMongoStoresPartitioned`). */
  db: Db;
  /** Where a tenant that loses a social app or its connections is logged. */
  log: (message: string) => void;
  /**
   * The sealing keys of the TOTP secrets and recovery codes
   * (`secondFactorKeysOf(masterKeys)`): the first seals, every one opens.
   */
  secondFactorKeys: [SealingKey, ...SealingKey[]];
  /** Opens the tenants' sealed social secrets. */
  secrets: SecretBox;
  /** The tenants' enterprise OIDC connections (M4, F1). */
  connections: ConnectionsOf;
  /** What accepting an invitation of this tenant checks and does (`noInvitationHooks` for a tenant with none). */
  invitationHooks: InvitationHooksFor;
  /** Hears the user events of one tenant's instance (D12). */
  events: (tenant: ResolvedTenant) => UserEventListener;
}

/**
 * One janus instance per tenant, chosen by host, rebuilt when the tenant's
 * `version` or its related origins change. The same resolver feeds the OAuth issuers.
 */
export function createTenantJanusIssuers({
  resolver,
  db,
  log,
  secondFactorKeys,
  secrets,
  connections,
  invitationHooks,
  events,
}: TenantJanusOptions) {
  return createJanusIssuers({
    resolve: async (request) => {
      const tenant = await resolver.resolveRequest(request);
      return tenant === null
        ? null
        : {
            issuer: tenant.issuer,
            // `origins` is fixed when the instance is built, so the version
            // also carries the related origins: verifying or removing a domain
            // rebuilds the cached instance (ADR-0036). It starts with the
            // tenant's id: a new tenant under a purged tenant's slug has the
            // same issuer and version, and must not get the old instance,
            // bound to the old partition (clavix-api#290).
            version: `${tenant.tenantId}.${tenant.version}.${fingerprintOf(tenant.relatedOrigins)}`,
            tenant,
          };
    },
    build: ({ tenant }) =>
      buildTenantJanus(
        db,
        tenant,
        log,
        secrets,
        invitationHooks(tenant),
        events(tenant),
        secondFactorKeys,
        connections,
      ),
  });
}
