import type { Clock } from "@softistx/janus";
import type { SigningKeyStore } from "@softistx/janus-oauth";
import {
  createMongoDPoPReplayCache,
  createMongoOAuth,
} from "@softistx/janus-oauth-mongo";
import type { createOidcProvider } from "@softistx/janus-oidc";
import type { Db } from "mongodb";
import { OIDC_SCOPES } from "@/modules/resources/scope-name";
import { lifetimes } from "./lifetimes";
import type {
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
  /** Specs inject the metadata documents' transport; production uses janus's. */
  metadataTransport?: MetadataTransport | undefined;
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
    metadataTransport,
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
      registration: registrationOf(tenant.oauth.agents, metadataTransport),
      // RFC 9126: `/par` is always served; `required` makes every client push.
      pushedAuthorizationRequests: { required: tenant.oauth.par.required },
      // RFC 9449: proofs are single-use (the Mongo replay cache is shared by
      // every instance) and carry a server nonce; `required` makes every
      // client of the tenant send one. A client may also require it alone
      // (`dpopBoundAccessTokens`).
      dpop: {
        algorithms: ["ES256", "EdDSA"] as const,
        required: tenant.oauth.dpop.required,
        replay: createMongoDPoPReplayCache(
          db,
          clock === undefined ? {} : { clock },
        ),
        nonce: { secret: dpopNonceSecret },
      },
      // RFC 8693: served by every tenant (see `exchangePolicy`).
      tokenExchange: { policy: exchangePolicy(exchangeRulesFor?.(tenant)) },
      lifetimes,
      accessTokens: {
        format: "jwt" as const,
        keys,
        // Runs on every code exchange and refresh: a refreshed token carries
        // the user's current roles. The audience is the token's resource.
        ...(rolesFor === undefined
          ? {}
          : {
              claims: async ({
                subject,
                audience,
              }: {
                subject: string;
                audience: string;
              }) => ({
                roles: await rolesFor(tenant)(
                  subject,
                  audience === userinfo ? null : audience,
                ),
              }),
            }),
      },
      tokenResponse: oidc.tokenResponse({ issuer: tenant.issuer, keys }),
      ...(clock === undefined ? {} : { clock }),
    };
  };
