import type { Clock } from "@softistx/janus";
import {
  createOAuthIssuers,
  type OAuthIssuerKey,
  type OAuthIssuers,
  type SigningKeyStore,
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
  const issuers = createOAuthIssuers<Keyed>({
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
      accessTokens: {
        format: "jwt",
        keys: requiringCurrentKey(
          signingKeysFor(tenant.tenantId),
          tenant.tenantId,
        ),
      },
      ...(clock === undefined ? {} : { clock }),
    }),
    endpoints: { consentUrl: options.consentUrl ?? "/consent" },
  });
  return {
    ...issuers,
    handle: async (request) => {
      try {
        return await issuers.handle(request);
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
