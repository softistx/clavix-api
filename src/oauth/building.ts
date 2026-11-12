import type { Clock } from "@softistx/janus";
import type { SigningKeyStore } from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { createOidcProvider } from "@softistx/janus-oidc";
import type { Db } from "mongodb";
import { lifetimes } from "./lifetimes";
import type { AuthFor, SigningKeysFor } from "./ports";
import type { Keyed } from "./resolution";
import { requiringCurrentKey } from "./signing-keys";

/** The userinfo endpoint of an issuer, also the resource of OIDC clients that send none. */
export const userinfoOf = (issuer: string) => `${issuer}/userinfo`;

/** The scopes the userinfo resource offers: the standard OpenID Connect ones. */
const OIDC_SCOPES = ["openid", "profile", "email"];

export interface BuildDeps {
  db: Db;
  signingKeysFor: SigningKeysFor;
  authFor: AuthFor;
  oidc: ReturnType<typeof createOidcProvider>;
  clock?: Clock | undefined;
}

/**
 * janus's `build`: the tenant's server config. One store signs access tokens
 * and id_tokens (the JWKS verifies both); the store of clients and grants is
 * the tenant's partition (ADR-0006).
 */
export const buildIssuer =
  ({ db, signingKeysFor, authFor, oidc, clock }: BuildDeps) =>
  ({ tenant, resources }: Keyed) => {
    const keys: SigningKeyStore = requiringCurrentKey(
      signingKeysFor(tenant.tenantId),
      tenant.tenantId,
    );
    const userinfo = userinfoOf(tenant.issuer);
    return {
      auth: authFor(tenant),
      store: createMongoOAuth(db, { partition: tenant.partition }),
      issuer: tenant.issuer,
      resources: { ...resources, [userinfo]: { scopes: OIDC_SCOPES } },
      defaultResource: userinfo,
      lifetimes,
      accessTokens: { format: "jwt" as const, keys },
      tokenResponse: oidc.tokenResponse({ issuer: tenant.issuer, keys }),
      ...(clock === undefined ? {} : { clock }),
    };
  };
