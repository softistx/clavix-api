import type {
  OAuthAuth,
  OAuthResource,
  SigningKeyStore,
} from "@softistx/janus-oauth";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

/**
 * The signing keys of a tenant (slice 1.2, `src/keys`). Called once per build
 * of a tenant's server, so it must return the tenant's own store: a key of
 * one tenant never signs a token of another.
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
