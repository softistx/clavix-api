import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

// Assumed, not answered (2026-11-12), confirm before the first production
// passkey: the passkey relying party is the tenant's own host. A passkey is
// scoped to its rpId for good, so this is the one place to change it (a custom
// domain is a WebAuthn related origin of this rpId, ADR-0036).

/** The WebAuthn rpId of a tenant: its host, `<slug>.<CLAVIX_DOMAIN>`, no port. */
export const rpIdOf = (tenant: Pick<ResolvedTenant, "slugIssuer">): string =>
  new URL(tenant.slugIssuer).hostname;

/** The origin a WebAuthn response of a tenant comes from: `https://<slug>.<CLAVIX_DOMAIN>` (`http://<slug>.clavix.localhost` in development). */
export const originOf = (tenant: Pick<ResolvedTenant, "slugIssuer">): string =>
  new URL(tenant.slugIssuer).origin;

/** A short stable digest of the related origins, for the instance cache's version. */
export const fingerprintOf = (origins: readonly string[]): string =>
  new Bun.CryptoHasher("sha256")
    .update([...origins].sort().join("\n"))
    .digest("hex")
    .slice(0, 12);
