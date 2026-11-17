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

/**
 * The protected resources a tenant serves (RFC 8707), by URL: its own APIs,
 * read from that tenant's scope (`resources:create`), so one tenant's resource
 * is never another's. Asked on every request.
 */
export type ResourcesFor = (
  tenant: ResolvedTenant,
) =>
  | Readonly<Record<string, OAuthResource>>
  | Promise<Readonly<Record<string, OAuthResource>>>;

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

/**
 * The `roles` claim of a tenant's users (slice A2c): the role names the user
 * holds, tenant-wide ones plus, when `audience` is the URI of one of the
 * tenant's resources, the ones scoped to it. `audience` is `null` for an
 * id_token and userinfo (no resource: tenant-wide roles only).
 */
export type RolesFor = (
  tenant: ResolvedTenant,
) => (userId: string, audience: string | null) => Promise<string[]>;

/** What a client may do with the token exchange grant (RFC 8693), from its `clientPolicies` rules. */
export interface ExchangeRules {
  /** URIs of the resources an exchanged token may be issued for. */
  targetResources: readonly string[];
  /** The clients whose tokens may be exchanged, or `"any"`. */
  subjectClients: readonly string[] | "any";
}

/**
 * The token exchange rules of a tenant's client, `null` when it has none: the
 * exchange is then refused (default-deny). Asked on every exchange, from the
 * tenant's own scope, so another tenant's rules are never read.
 */
export type ExchangeRulesFor = (
  tenant: ResolvedTenant,
) => (clientId: string) => Promise<ExchangeRules | null>;
