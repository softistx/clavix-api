import type { Clock } from "@softistx/janus";
import {
  createOAuthIssuers,
  type OAuthIssuerKey,
  type OAuthIssuers,
  type SigningKeyStore,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { createOidcProvider } from "@softistx/janus-oidc";
import type { Db } from "mongodb";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { lifetimes } from "./lifetimes";
import type { AuthFor, ClaimsFor, ResourcesFor, SigningKeysFor } from "./ports";

export interface ClavixOAuthOptions {
  /** Host to tenant: unknown and suspended hosts resolve to `null`, a 404. */
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus OAuth collections (`syncMongoOAuthPartitioned`). */
  db: Db;
  signingKeysFor: SigningKeysFor;
  authFor: AuthFor;
  /** The claims of a tenant's users, for the id_token and userinfo. */
  claimsFor: ClaimsFor;
  /** Default: no resource, so no `/authorize` succeeds (tenants' resources come with slice 2.3). */
  resourcesFor?: ResourcesFor;
  /** The hosted consent page, a path on the tenant's host. Default `/consent`. */
  consentUrl?: string;
  clock?: Clock;
}

/** A tenant has no `current` signing key yet (just created, rotation pending). */
export class NoSigningKeyError extends Error {
  constructor(readonly tenantId: string) {
    super(`tenant ${tenantId} has no current signing key yet`);
    this.name = "NoSigningKeyError";
  }
}

// The store janus signs with, failing with a typed error (not janus's bare
// `Error`) when the tenant has no current key, so `handle` can answer it.
function requiringCurrentKey(
  store: SigningKeyStore,
  tenantId: string,
): SigningKeyStore {
  return new Proxy(store, {
    get(target, property) {
      if (property !== "findCurrentKey") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (now: Date) => {
        const key = await target.findCurrentKey(now);
        if (key === null) throw new NoSigningKeyError(tenantId);
        return key;
      };
    },
  });
}

/** 503 with `Retry-After`: the keys of a new tenant arrive within moments. */
const unavailable = () =>
  Response.json(
    {
      error: "temporarily_unavailable",
      error_description: "the issuer has no signing key yet, retry shortly",
    },
    {
      status: 503,
      headers: { "retry-after": "30", "cache-control": "no-store" },
    },
  );

/** The userinfo endpoint of an issuer, also the resource of OIDC clients that send none. */
export const userinfoOf = (issuer: string) => `${issuer}/userinfo`;

/** The scopes the userinfo resource offers: the standard OpenID Connect ones. */
const OIDC_SCOPES = ["openid", "profile", "email"];

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
  const issuers = createOAuthIssuers<Keyed>({
    resolve: async (request) => {
      const tenant = await resolver.resolveRequest(request);
      return tenant === null
        ? null
        : { issuer: tenant.issuer, version: String(tenant.version), tenant };
    },
    build: ({ tenant }) => {
      tenantOf.set(tenant.issuer, tenant);
      // One store signs access tokens and id_tokens: the JWKS verifies both.
      const keys = requiringCurrentKey(
        signingKeysFor(tenant.tenantId),
        tenant.tenantId,
      );
      const userinfo = userinfoOf(tenant.issuer);
      return {
        auth: authFor(tenant),
        store: createMongoOAuth(db, { partition: tenant.partition }),
        issuer: tenant.issuer,
        resources: {
          ...(resourcesFor?.(tenant) ?? {}),
          [userinfo]: { scopes: OIDC_SCOPES },
        },
        defaultResource: userinfo,
        lifetimes,
        accessTokens: { format: "jwt", keys },
        tokenResponse: oidc.tokenResponse({ issuer: tenant.issuer, keys }),
        ...(clock === undefined ? {} : { clock }),
      };
    },
    endpoints: ({ tenant }) => ({
      consentUrl: options.consentUrl ?? "/consent",
      // Same-tenant confidential clients introspect the tokens of the
      // tenant's own resources (ADR-0024); a client of another tenant does
      // not authenticate here, its partition is another.
      introspection: {
        authorize: () => ({
          resources: Object.keys(resourcesFor?.(tenant) ?? {}),
        }),
      },
    }),
  });
  const openid = oidc.issuers(issuers, { resource: userinfoOf });
  return {
    ...issuers,
    handle: async (request) => {
      try {
        return (
          (await openid.handle(request)) ?? (await issuers.handle(request))
        );
      } catch (error) {
        if (error instanceof NoSigningKeyError) {
          console.warn(`oauth: ${error.message}`);
          return unavailable();
        }
        throw error;
      }
    },
  };
}
