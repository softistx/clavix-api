import type { Clock } from "@softistx/janus";
import type {
  OAuthEventListener,
  OAuthResource,
  SigningKeyStore,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { createOidcProvider } from "@softistx/janus-oidc";
import type { Db } from "mongodb";
import { OIDC_SCOPES } from "@/modules/resources";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import {
  accessTokenClaims,
  deviceOf,
  dpopOf,
  registrationFor,
  userinfoOf,
} from "./building-parts";
import { lifetimes } from "./lifetimes";
import type {
  AgentCheckFor,
  AttributesFor,
  AuthFor,
  ExchangeRulesFor,
  KeyedResource,
  PermissionsFor,
  RolesFor,
  SigningKeysFor,
} from "./ports";
import type { MetadataTransport } from "./registration";
import type { Keyed } from "./resolution";
import { exchangePolicy } from "./token-exchange";

export { userinfoOf };

// `enforceRbac` is Clavix's own: janus is given its resources as it knows them.
const withoutRbacFlag = (
  resources: Readonly<Record<string, KeyedResource>>,
): Record<string, OAuthResource> =>
  Object.fromEntries(
    Object.entries(resources).map(([uri, { enforceRbac: _, ...rest }]) => [
      uri,
      rest,
    ]),
  );

export interface BuildDeps {
  db: Db;
  signingKeysFor: SigningKeysFor;
  dpopNonceSecret: string;
  authFor: AuthFor;
  oidc: ReturnType<typeof createOidcProvider>;
  clock: Clock;
  rolesFor: RolesFor;
  permissionsFor: PermissionsFor;
  attributesFor: AttributesFor;
  exchangeRulesFor: ExchangeRulesFor;
  agentCheckFor: AgentCheckFor;
  /** The listener of a tenant's OAuth events (D12, D14). */
  eventsFor: (tenant: ResolvedTenant) => OAuthEventListener;
  /** Specs inject the metadata documents' transport; production uses janus's. */
  metadataTransport?: MetadataTransport | undefined;
  /** The ports a metadata document may be served on. Default: 443. */
  metadataPorts?: readonly number[] | undefined;
}

/**
 * janus's `build`: the tenant's server config. One store signs access tokens
 * and id_tokens (the JWKS verifies both); the store of clients and grants is
 * the tenant's partition (ADR-0006).
 */
export const buildIssuer =
  ({
    db,
    signingKeysFor,
    dpopNonceSecret,
    authFor,
    oidc,
    clock,
    rolesFor,
    permissionsFor,
    attributesFor,
    exchangeRulesFor,
    agentCheckFor,
    metadataTransport,
    metadataPorts,
    eventsFor,
  }: BuildDeps) =>
  ({ tenant, resources }: Keyed) => {
    const keys: SigningKeyStore = signingKeysFor(tenant.tenantId);
    const userinfo = userinfoOf(tenant.issuer);
    return {
      auth: authFor(tenant),
      store: createMongoOAuth(db, { partition: tenant.partition }),
      issuer: tenant.issuer,
      resources: {
        ...withoutRbacFlag(resources),
        [userinfo]: { scopes: [...OIDC_SCOPES] },
      },
      defaultResource: userinfo,
      deviceAuthorization: deviceOf(tenant),
      registration: registrationFor(tenant, metadataTransport, metadataPorts),
      // RFC 9126: `/par` is always served; `required` makes every client push.
      pushedAuthorizationRequests: { required: tenant.oauth.par.required },
      dpop: dpopOf(tenant, db, clock, dpopNonceSecret),
      // RFC 6749 section 4.4: served by a tenant with at least one resource
      // that opted in (`allowClientCredentials`); janus throws when it is on
      // and none did. The userinfo resource never opts in. A request for any
      // other resource, or none (the default is userinfo), is `invalid_target`.
      clientCredentials: Object.values(resources).some(
        (resource) => resource.clientCredentials === true,
      ),
      // RFC 8693: served by every tenant (see `exchangePolicy`).
      tokenExchange: {
        policy: exchangePolicy(exchangeRulesFor(tenant), agentCheckFor(tenant)),
      },
      // Consents, revocations, reuse, device decisions, exchanges and
      // registrations of THIS tenant's issuer, for its own log only (D14).
      events: eventsFor(tenant),
      lifetimes,
      accessTokens: {
        format: "jwt" as const,
        keys,
        claims: accessTokenClaims(
          tenant,
          rolesFor,
          attributesFor,
          permissionsFor,
        ),
      },
      tokenResponse: oidc.tokenResponse({ issuer: tenant.issuer, keys }),
      clock,
    };
  };
