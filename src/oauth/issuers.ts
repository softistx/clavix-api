import type { Clock } from "@softistx/janus";
import { createOAuthIssuers, type OAuthIssuers } from "@softistx/janus-oauth";
import { createOidcProvider } from "@softistx/janus-oidc";
import type { Db } from "mongodb";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { buildIssuer, userinfoOf } from "./building";
import type { AuthFor, ClaimsFor, ResourcesFor, SigningKeysFor } from "./ports";
import { type Keyed, resolveIssuer } from "./resolution";

export interface ClavixOAuthOptions {
  /** Host to tenant: unknown and suspended hosts resolve to `null`, a 404. */
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus OAuth collections (`syncMongoOAuthPartitioned`). */
  db: Db;
  signingKeysFor: SigningKeysFor;
  authFor: AuthFor;
  /** The claims of a tenant's users, for the id_token and userinfo. */
  claimsFor: ClaimsFor;
  /**
   * The tenants' own resources (their APIs, `resources:create`); the userinfo
   * resource is always added. Default: none, so only OIDC clients that ask for
   * userinfo's resource (or none) succeed. Read on every request, so a resource
   * registered by script serves at once: its fingerprint is part of the
   * issuer's cache version.
   */
  resourcesFor?: ResourcesFor;
  /** The hosted consent page, a path on the tenant's host. Default `/consent`. */
  consentUrl?: string;
  clock?: Clock;
}

export { userinfoOf } from "./building";

/**
 * One OAuth authorization server per tenant (ADR-0003): the issuer is the
 * tenant's, its store is the tenant's partition of the janus collections
 * (ADR-0006) and its signing keys are the tenant's. A server is rebuilt when
 * the tenant's `version` changes, i.e. after any tenant write. Resolution is
 * `resolution.ts`, the server config `building.ts`.
 */
export function createClavixOAuthIssuers(
  options: ClavixOAuthOptions,
): OAuthIssuers {
  const { resolver, db, signingKeysFor, authFor, resourcesFor, clock } =
    options;
  // issuer -> tenant, filled by `build`: janus gives `claims` the issuer
  // `resolve` answered, and a server is always built before it answers.
  const tenantOf = new Map<string, ResolvedTenant>();
  const oidc = createOidcProvider({
    claims: (subject, scopes, { issuer }) => {
      const tenant = tenantOf.get(issuer);
      if (tenant === undefined) {
        throw new Error(`oidc: no tenant built for issuer ${issuer}`);
      }
      return options.claimsFor(tenant)(subject, scopes);
    },
  });
  const build = buildIssuer({ db, signingKeysFor, authFor, oidc, clock });
  const issuers = createOAuthIssuers<Keyed>({
    resolve: resolveIssuer(resolver, resourcesFor),
    build: (keyed) => {
      tenantOf.set(keyed.tenant.issuer, keyed.tenant);
      return build(keyed);
    },
    endpoints: ({ resources }) => ({
      consentUrl: options.consentUrl ?? "/consent",
      // Same-tenant confidential clients introspect the tokens of the
      // tenant's own resources (ADR-0024); a client of another tenant does
      // not authenticate here, its partition is another.
      introspection: {
        authorize: () => ({
          resources: Object.keys(resources),
        }),
      },
    }),
  });
  const openid = oidc.issuers(issuers, { resource: userinfoOf });
  return {
    ...issuers,
    handle: async (request) =>
      (await openid.handle(request)) ?? (await issuers.handle(request)),
  };
}
