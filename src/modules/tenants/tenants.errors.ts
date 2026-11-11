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
