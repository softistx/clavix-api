import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

// Assumed, not answered (2026-11-12), confirm before the first production
// passkey: the passkey relying party is the tenant's own host. A passkey is
// scoped to its rpId for good, so this is the one place to change it (a custom
// domain would go through WebAuthn Related Origins, a later slice).

/** The WebAuthn rpId of a tenant: its host, `<slug>.<CLAVIX_DOMAIN>`, no port. */
export const rpIdOf = (tenant: Pick<ResolvedTenant, "issuer">): string =>
  new URL(tenant.issuer).hostname;

/** The origin a WebAuthn response of a tenant comes from: `https://<slug>.<CLAVIX_DOMAIN>`. */
export const originOf = (tenant: Pick<ResolvedTenant, "issuer">): string =>
  new URL(tenant.issuer).origin;

/** Temporary, until @softistx/janus#668: janus takes https origins only (browsers offer passkeys on a secure origin): a development server on http has none. */
export const passkeysOn = (tenant: Pick<ResolvedTenant, "issuer">): boolean =>
  originOf(tenant).startsWith("https://");
