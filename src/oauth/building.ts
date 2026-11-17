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
import type { Keyed } from "./resolution";

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
      deviceAuthorization: { verificationUri: `${tenant.issuer}/device` },
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
      // RFC 8693: served by every tenant, gated per client by its grants (the
      // exchange URN is never implied) and by its rules in `clientPolicies`.
      // Default-deny, delegation only: a client with no rules, a subject
      // token of a client it does not list or a target it does not list is
      // `access_denied`. janus only lets the scopes narrow.
      tokenExchange: {
        policy: async ({
          clientId,
          subject,
          resource,
        }: {
          clientId: string;
          subject: { clientId: string };
          resource: string;
        }) => {
          const rules = await exchangeRulesFor?.(tenant)(clientId);
          if (rules === undefined || rules === null) return null;
          if (!rules.targetResources.includes(resource)) return null;
          if (
            rules.subjectClients !== "any" &&
            !rules.subjectClients.includes(subject.clientId)
          ) {
            return null;
          }
          return { mode: "delegation" as const };
        },
      },
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
