import type {
  OAuthAuth,
  OAuthResource,
  SigningKeyStore,
} from "@softistx/janus-oauth";
import type { OidcClaims, OidcSubject } from "@softistx/janus-oidc";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

/**
 * The signing keys of a tenant (slice 1.2, `src/keys`). Called once per build
 * of a tenant's server, so it must return the tenant's own store: a key of
 * one tenant never signs a token of another. It takes the tenant's id (the
 * partition of its keys is that id, `ResolvedTenant.partition`). The store
 * must hold a `current` key (slice 1.2 rotates them): access tokens are JWTs
 * (ADR-0009) and the store also serves the tenant's `/jwks.json`.
 */
export type SigningKeysFor = (tenantId: string) => SigningKeyStore;

/**
 * The end-user authentication of a tenant (slice 1.5): the user pool is per
 * tenant (ADR-0008), so `authenticate` and `findUser` only know that
 * tenant's users.
 */
export type AuthFor = (tenant: ResolvedTenant) => OAuthAuth;

/** The protected resources a tenant serves (RFC 8707), by URL. */
export type ResourcesFor = (
  tenant: ResolvedTenant,
) => Readonly<Record<string, OAuthResource>>;

/**
 * The claims of a tenant's users (slice 1.4): looks the subject up in that
 * tenant's user pool (ADR-0008) and returns every claim it knows; the scopes
 * of the token decide which are released. The real one comes with the users
 * (slice 1.5).
 */
export type ClaimsFor = (
  tenant: ResolvedTenant,
) => (
  subject: OidcSubject,
  scopes: readonly string[],
) => OidcClaims | Promise<OidcClaims>;
