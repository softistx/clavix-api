import type { OAuthIssuerKey } from "@softistx/janus-oauth";
import { digestOf } from "@/modules/resources";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import type { KeyedResource, ResourcesFor } from "./ports";

// What `resolve` answers: janus's key (the version as a string) and the tenant.
export type Keyed = OAuthIssuerKey & {
  tenant: ResolvedTenant;
  resources: Readonly<Record<string, KeyedResource>>;
};

// A short stable digest of a tenant's resources: the issuer is rebuilt when
// one is added, changed or removed, though the tenant itself did not change.
// The detail types count by name and by the digest of their definition
// (`digestOf`), so an edited type rebuilds the issuer.
export const fingerprintOf = (
  resources: Readonly<Record<string, KeyedResource>>,
) =>
  Bun.hash(
    JSON.stringify(
      Object.entries(resources)
        .map(
          ([
            uri,
            { scopes, authorizationDetails, clientCredentials, enforceRbac },
          ]) => {
            const types = Object.entries(authorizationDetails ?? {})
              .map(([type, { schema }]) => [type, digestOf(schema) ?? ""])
              .sort(([a], [b]) => String(a).localeCompare(String(b)));
            const base = [uri, [...scopes].sort()];
            // Added only when set, so a tenant that has none keeps its
            // fingerprint (and its cached issuer) across the release.
            if (clientCredentials === true) base.push("cc");
            if (enforceRbac === true) base.push("rbac");
            return types.length === 0 ? base : [...base, types];
          },
        )
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ),
  ).toString(36);

// janus refuses a resource with no scope and no detail type (a TypeError when
// the server is built) and the introspection list must not name one, so a
// stored resource that has neither is left out here, once, for both.
const withScopes = (
  resources: Readonly<Record<string, KeyedResource>>,
): Readonly<Record<string, KeyedResource>> =>
  Object.fromEntries(
    Object.entries(resources).filter(
      ([, { scopes, authorizationDetails }]) =>
        scopes.length > 0 || Object.keys(authorizationDetails ?? {}).length > 0,
    ),
  );

/**
 * janus's `resolve`: the request's host to its tenant (`null`: none, a 404) and
 * the tenant's stored resources, whose fingerprint is part of the version.
 */
export const resolveIssuer =
  (
    resolver: Pick<TenantResolver, "resolveRequest">,
    resourcesFor: ResourcesFor,
  ) =>
  async (request: Request): Promise<Keyed | null> => {
    const tenant = await resolver.resolveRequest(request);
    if (tenant === null) return null;
    const resources = withScopes(await resourcesFor(tenant));
    return {
      issuer: tenant.issuer,
      // The tenant's id first: a new tenant under a purged tenant's slug has
      // the same issuer and version (clavix-api#290).
      version: `${tenant.tenantId}.${tenant.version}.${fingerprintOf(resources)}`,
      tenant,
      resources,
    };
  };
