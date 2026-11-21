import { defineCodes } from "@/i18n/define-codes";
/** The slug is not a valid, unreserved DNS label. */
export class InvalidSlugError extends Error {
  override name = "InvalidSlugError";
}

/** Another live tenant has this slug. */
export class SlugTakenError extends Error {
  override name = "SlugTakenError";
}

/** The platform tenant cannot be suspended or deleted. */
export class PlatformTenantProtectedError extends Error {
  override name = "PlatformTenantProtectedError";
}

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("tenants", [
  "SLUG_TAKEN",
  "PLATFORM_TENANT_PROTECTED",
  "QUOTA_EXCEEDED",
  "TENANT_SUSPENDED",
]);
