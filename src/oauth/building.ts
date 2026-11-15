import type { Clock } from "@softistx/janus";
import type { SigningKeyStore } from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { createOidcProvider } from "@softistx/janus-oidc";
import type { Db } from "mongodb";
import { OIDC_SCOPES } from "@/modules/resources/scope-name";
import { lifetimes } from "./lifetimes";
import type { AuthFor, RolesFor, SigningKeysFor } from "./ports";
import type { Keyed } from "./resolution";

// janus refuses a resource with no scope (a TypeError when the server is built),
// so a stored resource that has none is left out instead of taking the tenant down.
const withScopes = (resources: Keyed["resources"]): Keyed["resources"] =>
  Object.fromEntries(
    Object.entries(resources).filter(([, { scopes }]) => scopes.length > 0),
  );

/** The userinfo endpoint of an issuer, also the resource of OIDC clients that send none. */
export const userinfoOf = (issuer: string) => `${issuer}/userinfo`;

export interface BuildDeps {
  db: Db;
  signingKeysFor: SigningKeysFor;
  authFor: AuthFor;
  oidc: ReturnType<typeof createOidcProvider>;
  clock?: Clock | undefined;
  rolesFor?: RolesFor | undefined;
}

/**
 * janus's `build`: the tenant's server config. One store signs access tokens
 * and id_tokens (the JWKS verifies both); the store of clients and grants is
 * the tenant's partition (ADR-0006).
 */
export const buildIssuer =
  ({ db, signingKeysFor, authFor, oidc, clock, rolesFor }: BuildDeps) =>
  ({ tenant, resources }: Keyed) => {
    const keys: SigningKeyStore = signingKeysFor(tenant.tenantId);
    const userinfo = userinfoOf(tenant.issuer);
    return {
      auth: authFor(tenant),
      store: createMongoOAuth(db, { partition: tenant.partition }),
      issuer: tenant.issuer,
      resources: {
        ...withScopes(resources),
        [userinfo]: { scopes: [...OIDC_SCOPES] },
      },
      defaultResource: userinfo,
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
