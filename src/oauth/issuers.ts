import type { Clock } from "@softistx/janus";
import {
  createOAuthIssuers,
  type OAuthIssuerKey,
  type OAuthIssuers,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { lifetimes } from "./lifetimes";
import type { AuthFor, ResourcesFor, SigningKeysFor } from "./ports";

export interface ClavixOAuthOptions {
  /** Host to tenant: unknown and suspended hosts resolve to `null`, a 404. */
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus OAuth collections (`syncMongoOAuthPartitioned`). */
  db: Db;
  signingKeysFor: SigningKeysFor;
  authFor: AuthFor;
  /** Default: no resource, so no `/authorize` succeeds (tenants' resources come with slice 2.3). */
  resourcesFor?: ResourcesFor;
  /** The hosted consent page, a path on the tenant's host. Default `/consent`. */
  consentUrl?: string;
  clock?: Clock;
}

// What `resolve` answers: janus's key (the version as a string) and the tenant.
type Keyed = OAuthIssuerKey & { tenant: ResolvedTenant };

/**
 * One OAuth authorization server per tenant (ADR-0003): the issuer is the
 * tenant's, its store is the tenant's partition of the janus collections
 * (ADR-0006) and its signing keys are the tenant's. A server is rebuilt when
 * the tenant's `version` changes, i.e. after any tenant write.
 */
export function createClavixOAuthIssuers(
  options: ClavixOAuthOptions,
): OAuthIssuers {
  const { resolver, db, signingKeysFor, authFor, resourcesFor, clock } =
    options;
  return createOAuthIssuers<Keyed>({
    resolve: async (request) => {
      const tenant = await resolver.resolveRequest(request);
      return tenant === null
        ? null
        : { issuer: tenant.issuer, version: String(tenant.version), tenant };
    },
    build: ({ tenant }) => ({
      auth: authFor(tenant),
      store: createMongoOAuth(db, { partition: tenant.partition }),
      issuer: tenant.issuer,
      resources: resourcesFor?.(tenant) ?? {},
      lifetimes,
      accessTokens: { format: "jwt", keys: signingKeysFor(tenant.tenantId) },
      ...(clock === undefined ? {} : { clock }),
    }),
    endpoints: { consentUrl: options.consentUrl ?? "/consent" },
  });
}
