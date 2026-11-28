import type {
  OAuthAuth,
  OAuthResource,
  SigningKeyStore,
} from "@softistx/janus-oauth";
import type { OidcClaims, OidcSubject } from "@softistx/janus-oidc";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

/**
 * The signing keys of a tenant (slice 1.2, `src/modules/keys`). Called once per build
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
  | Readonly<Record<string, KeyedResource>>
  | Promise<Readonly<Record<string, KeyedResource>>>;

/**
 * A stored resource as `ResourcesFor` answers it: janus's, plus Clavix's own
 * `enforceRbac` flag (set only when on). It is part of the issuer's
 * fingerprint and never reaches janus (`building.ts` strips it).
 */
export type KeyedResource = OAuthResource & { enforceRbac?: true };

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

/**
 * The `permissions` claim of a tenant's users (slice 5.2a): the sorted scope
 * names of the resource whose URI is `audience`, granted by the roles the user
 * holds (tenant-wide ones and those scoped to that resource). `null` means no
 * claim: no audience, an unknown resource, or a resource that does not enforce
 * RBAC (`Resource.enforceRbac` off). `[]` is a user who holds no permission on
 * an enforcing resource. Required: no default, so an unbound port is a type error.
 */
export type PermissionsFor = (
  tenant: ResolvedTenant,
) => (userId: string, audience: string | null) => Promise<string[] | null>;

/**
 * The attribute claims of a tenant's users (user-attributes slice A6): each
 * attribute whose emission scope is among `scopes`, that the user has a value
 * for, and, for a role attribute, that a role the user holds links and that
 * applies to `audience` (see `RolesFor`). `audience` is `null` when the token
 * has no resource (the ID token and userinfo are issued for none, so only a
 * tenant-wide role counts there).
 */
export type AttributesFor = (
  tenant: ResolvedTenant,
) => (
  userId: string,
  scopes: readonly string[],
  audience: string | null,
) => Promise<Record<string, unknown>>;

/**
 * The scope table of a tenant's attribute claims: each emission scope to the
 * claim keys it releases. It tells the ID token, userinfo and the discovery
 * document's `claims_supported` which claims the tenant's scopes carry.
 */
export type AttributeScopesFor = (
  tenant: ResolvedTenant,
) => () => Promise<Record<string, readonly string[]>>;

/** What a client may do with the token exchange grant (RFC 8693), from its `clientPolicies` rules. */
export interface ExchangeRules {
  /** URIs of the resources an exchanged token may be issued for. */
  targetResources: readonly string[];
  /** The clients whose tokens may be exchanged, or `"any"`. */
  subjectClients: readonly string[] | "any";
  /** Whether the tokens of the tenant's agents (D12) may be exchanged too. */
  subjectAgents: boolean;
}

/** Whether a client of the tenant is an agent (it registered itself, `agentClients`). */
export type AgentCheckFor = (
  tenant: ResolvedTenant,
) => (clientId: string) => Promise<boolean>;

/**
 * The token exchange rules of a tenant's client, `null` when it has none: the
 * exchange is then refused (default-deny). Asked on every exchange, from the
 * tenant's own scope, so another tenant's rules are never read.
 */
export type ExchangeRulesFor = (
  tenant: ResolvedTenant,
) => (clientId: string) => Promise<ExchangeRules | null>;
