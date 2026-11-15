import type { OAuthIssuerKey, OAuthResource } from "@softistx/janus-oauth";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import type { ResourcesFor } from "./ports";

// What `resolve` answers: janus's key (the version as a string) and the tenant.
export type Keyed = OAuthIssuerKey & {
  tenant: ResolvedTenant;
  resources: Readonly<Record<string, OAuthResource>>;
};

// A short stable digest of a tenant's resources: the issuer is rebuilt when
// one is added, changed or removed, though the tenant itself did not change.
export const fingerprintOf = (
  resources: Readonly<Record<string, OAuthResource>>,
) =>
  Bun.hash(
    JSON.stringify(
      Object.entries(resources)
        .map(([uri, { scopes }]) => [uri, [...scopes].sort()])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ),
  ).toString(36);

// janus refuses a resource with no scope (a TypeError when the server is built)
// and the introspection list must not name one, so a stored resource that has
// none is left out here, once, for both.
const withScopes = (
  resources: Readonly<Record<string, OAuthResource>>,
): Readonly<Record<string, OAuthResource>> =>
  Object.fromEntries(
    Object.entries(resources).filter(([, { scopes }]) => scopes.length > 0),
  );

/**
 * janus's `resolve`: the request's host to its tenant (`null`: none, a 404) and
 * the tenant's stored resources, whose fingerprint is part of the version.
 */
export const resolveIssuer =
  (
    resolver: Pick<TenantResolver, "resolveRequest">,
    resourcesFor: ResourcesFor | undefined,
  ) =>
  async (request: Request): Promise<Keyed | null> => {
    const tenant = await resolver.resolveRequest(request);
    if (tenant === null) return null;
    const resources = withScopes((await resourcesFor?.(tenant)) ?? {});
    return {
      issuer: tenant.issuer,
      version: `${tenant.version}.${fingerprintOf(resources)}`,
      tenant,
      resources,
    };
  };
