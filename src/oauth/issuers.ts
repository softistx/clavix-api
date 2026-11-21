import type { Clock } from "@softistx/janus";
import {
  createOAuthIssuers,
  type OAuthEventListener,
  type OAuthIssuers,
} from "@softistx/janus-oauth";
import {
  createOidcProvider,
  type OidcClaims,
  type OidcSubject,
} from "@softistx/janus-oidc";
import { instrumentOAuth } from "@softistx/janus-telemetry";
import type { Db } from "mongodb";
import { tenantAttributes } from "@/telemetry/tenant";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { SUPPORTED_ACR } from "./authentication-level";
import { buildIssuer, userinfoOf } from "./building";
import type {
  AgentCheckFor,
  AuthFor,
  ClaimsFor,
  ExchangeRulesFor,
  ResourcesFor,
  RolesFor,
  SigningKeysFor,
} from "./ports";
import type { MetadataTransport } from "./registration";
import { type Keyed, resolveIssuer } from "./resolution";

export interface ClavixOAuthOptions {
  /** Host to tenant: unknown and suspended hosts resolve to `null`, a 404. */
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus OAuth collections (`syncMongoOAuthPartitioned`). */
  db: Db;
  signingKeysFor: SigningKeysFor;
  /**
   * The secret of the DPoP server nonces (`dpopNonceSecretOf`, `src/config/keys.ts`):
   * the same on every instance, never empty.
   */
  dpopNonceSecret: string;
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
  /**
   * The `roles` claim (slice A2c): in the id_token and userinfo (tenant-wide
   * roles, released by the `openid` scope) and in the JWT access tokens
   * (tenant-wide plus the roles of the token's resource). Absent: no claim.
   */
  rolesFor?: RolesFor;
  /**
   * The token exchange rules of a tenant's clients (`clientPolicies`). Absent:
   * no client may exchange tokens.
   */
  exchangeRulesFor?: ExchangeRulesFor;
  /** Whether a client is an agent (`agentClients`); with `subjectAgents` rules. Absent: none is. */
  agentCheckFor?: AgentCheckFor;
  /** The transport of the Client ID Metadata Documents fetch; for specs. Default: janus's own. */
  metadataTransport?: MetadataTransport;
  /** The ports a metadata document may be served on (`CLAVIX_METADATA_PORTS`). Default: 443. */
  metadataPorts?: readonly number[];
  /**
   * The listener of a tenant's OAuth events, built per tenant so its events
   * can only reach that tenant's log (D12, D14). Absent: none is reported.
   */
  eventsFor?: (tenant: ResolvedTenant) => OAuthEventListener;
  /** The hosted consent page, a path on the tenant's host. Default `/consent`. */
  consentUrl?: string;
  clock: Clock;
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
      return withRoles(
        tenant,
        subject,
        options.claimsFor(tenant)(subject, scopes),
      );
    },
    // `openid` releases nothing else (`sub` aside), so roles go with every
    // OpenID Connect token, in the id_token as well as at userinfo.
    scopeClaims: { openid: ["roles"] },
    // D9: the `acr` values a client may ask for (`acr_values`, enforced at
    // approval, `authentication-level.ts`).
    acrValuesSupported: SUPPORTED_ACR,
    idToken: { includeClaims: true },
  });
  const withRoles = async (
    tenant: ResolvedTenant,
    subject: OidcSubject,
    claims: OidcClaims | Promise<OidcClaims>,
  ): Promise<OidcClaims> =>
    options.rolesFor === undefined
      ? claims
      : {
          ...(await claims),
          roles: await options.rolesFor(tenant)(subject.id, null),
        };
  const build = buildIssuer({
    db,
    signingKeysFor,
    dpopNonceSecret: options.dpopNonceSecret,
    authFor,
    oidc,
    clock,
    rolesFor: options.rolesFor,
    exchangeRulesFor: options.exchangeRulesFor,
    agentCheckFor: options.agentCheckFor,
    metadataTransport: options.metadataTransport,
    metadataPorts: options.metadataPorts,
    eventsFor: options.eventsFor,
  });
  const issuers = createOAuthIssuers<Keyed>({
    resolve: resolveIssuer(resolver, resourcesFor),
    build: (keyed) => {
      tenantOf.set(keyed.tenant.issuer, keyed.tenant);
      return build(keyed);
    },
    // Traced (D24): a span per endpoint, the refused client authentications as
    // warnings; the tenant's id and plan on each, never a token, secret or address.
    instrument: (server, { tenant }) =>
      instrumentOAuth(server, { attributes: () => tenantAttributes(tenant) }),
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
