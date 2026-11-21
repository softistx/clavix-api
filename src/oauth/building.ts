import type { Clock } from "@softistx/janus";
import type {
  OAuthEventListener,
  SigningKeyStore,
} from "@softistx/janus-oauth";
import {
  createMongoDPoPReplayCache,
  createMongoOAuth,
} from "@softistx/janus-oauth-mongo";
import type { createOidcProvider } from "@softistx/janus-oidc";
import type { Db } from "mongodb";
import { DPOP_ALGORITHMS, OIDC_SCOPES } from "@/modules/resources";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { lifetimes } from "./lifetimes";
import type {
  AgentCheckFor,
  AuthFor,
  ExchangeRulesFor,
  RolesFor,
  SigningKeysFor,
} from "./ports";
import { type MetadataTransport, registrationOf } from "./registration";
import type { Keyed } from "./resolution";
import { exchangePolicy } from "./token-exchange";

/** The userinfo endpoint of an issuer, also the resource of OIDC clients that send none. */
export const userinfoOf = (issuer: string) => `${issuer}/userinfo`;

export interface BuildDeps {
  db: Db;
  signingKeysFor: SigningKeysFor;
  dpopNonceSecret: string;
  authFor: AuthFor;
  oidc: ReturnType<typeof createOidcProvider>;
  clock?: Clock | undefined;
  rolesFor?: RolesFor | undefined;
  /** Absent: no client may exchange tokens. */
  exchangeRulesFor?: ExchangeRulesFor | undefined;
  /** Absent: no client is an agent, so `subjectAgents` covers nothing. */
  agentCheckFor?: AgentCheckFor | undefined;
  /** The listener of a tenant's OAuth events (D12, D14); absent: none is reported. */
  eventsFor?: ((tenant: ResolvedTenant) => OAuthEventListener) | undefined;
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
        ...resources,
        [userinfo]: { scopes: [...OIDC_SCOPES] },
      },
      defaultResource: userinfo,
      // RFC 8628: served by every tenant, gated per client by its grants (the
      // device URN is never implied). The page is the hosted `/device` of the
      // issuer's own host; `/device_authorization` is janus's endpoint.
      // An agent (a client that registered itself) gets no device grant (D11).
      deviceAuthorization: {
        verificationUri: `${tenant.issuer}/device`,
        dynamicClients: false,
      },
      // Agents (D7, D8): off unless the tenant opted in; `/register` is ours
      // (`register-route.ts`), not janus's.
      registration: registrationOf(
        tenant.oauth.agents,
        metadataTransport,
        metadataPorts,
      ),
      // RFC 9126: `/par` is always served; `required` makes every client push.
      pushedAuthorizationRequests: { required: tenant.oauth.par.required },
      // RFC 9449: proofs are single-use (the Mongo replay cache is shared by
      // every instance) and carry a server nonce; `required` makes every
      // client of the tenant send one. A client may also require it alone
      // (`dpopBoundAccessTokens`).
      dpop: {
        algorithms: DPOP_ALGORITHMS,
        required: tenant.oauth.dpop.required,
        replay: createMongoDPoPReplayCache(
          db,
          clock === undefined ? {} : { clock },
        ),
        nonce: { secret: dpopNonceSecret },
      },
      // RFC 6749 section 4.4: served by a tenant with at least one resource
      // that opted in (`allowClientCredentials`); janus throws when it is on
      // and none did. The userinfo resource never opts in. A request for any
      // other resource, or none (the default is userinfo), is `invalid_target`.
      clientCredentials: Object.values(resources).some(
        (resource) => resource.clientCredentials === true,
      ),
      // RFC 8693: served by every tenant (see `exchangePolicy`).
      tokenExchange: {
        policy: exchangePolicy(
          exchangeRulesFor?.(tenant),
          agentCheckFor?.(tenant),
        ),
      },
      // Consents, revocations, reuse, device decisions, exchanges and
      // registrations of THIS tenant's issuer, for its own log only (D14).
      ...(eventsFor === undefined ? {} : { events: eventsFor(tenant) }),
      lifetimes,
      accessTokens: {
        format: "jwt" as const,
        keys,
        // Runs on every code exchange and refresh: a refreshed token carries
        // the user's current roles. The audience is the token's resource.
        // `acr`, `amr` and `auth_time` are the grant's, the values of the ID
        // token (RFC 9068, RFC 9470); a grant that records none adds none.
        claims: async ({
          subject,
          audience,
          authTime,
          acr,
          amr,
          subjectType,
        }: {
          subject: string;
          /** `client` for a client credentials token: the subject is a client id, not a user. */
          subjectType?: "client" | "user";
          audience: string;
          authTime?: Date;
          acr?: string;
          amr?: readonly string[];
        }) => ({
          // A machine has no roles: its subject is a client id, not a user.
          ...(rolesFor === undefined || subjectType === "client"
            ? {}
            : {
                roles: await rolesFor(tenant)(
                  subject,
                  audience === userinfo ? null : audience,
                ),
              }),
          ...(authTime === undefined
            ? {}
            : { auth_time: Math.floor(authTime.getTime() / 1000) }),
          ...(acr === undefined ? {} : { acr }),
          ...(amr === undefined ? {} : { amr: [...amr] }),
        }),
      },
      tokenResponse: oidc.tokenResponse({ issuer: tenant.issuer, keys }),
      ...(clock === undefined ? {} : { clock }),
    };
  };
