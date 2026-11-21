// A tenant's slug is the DNS label its issuer lives under
// (`<slug>.<CLAVIX_DOMAIN>`): 2–63 characters, lowercase letters, digits and
// inner hyphens. It is immutable once the tenant exists (the service has no
// way to change it), since the issuer is what relying parties registered.

// Labels the platform keeps for itself.
export const RESERVED_SLUGS: readonly string[] = [
  "console",
  "www",
  "api",
  "admin",
  "auth",
  "id",
  "login",
  "status",
  "docs",
  "static",
  "cdn",
  "mail",
];

/** The platform's own tenant: it cannot be suspended or deleted. */
export const PLATFORM_TENANT_SLUG = "clavix";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Why a slug is refused, or `undefined` when it is a valid, free label. */
export function slugProblem(slug: string): string | undefined {
  if (slug.length < 2 || slug.length > 63) {
    return "a slug has 2 to 63 characters";
  }
  if (!SLUG_PATTERN.test(slug)) {
    return "a slug is lowercase letters, digits and inner hyphens";
  }
  if (RESERVED_SLUGS.includes(slug)) return `"${slug}" is reserved`;
  return undefined;
}
