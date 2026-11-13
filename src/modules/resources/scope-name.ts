// Same shape as an OAuth scope token (RFC 6749 §3.3): printable ASCII, no
// space, quote or backslash.
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** The scope name's problem, or `null`. */
export function scopeNameProblem(name: string): string | null {
  return SCOPE_PATTERN.test(name)
    ? null
    : `scope "${name}" must be printable ASCII without space, quote or backslash`;
}

/**
 * The scopes of the userinfo resource (`src/oauth/building.ts`): the standard
 * OpenID Connect ones, built in and owned by no resource.
 */
export const OIDC_SCOPES = ["openid", "profile", "email"] as const;

export const isOidcScope = (name: string): boolean =>
  (OIDC_SCOPES as readonly string[]).includes(name);
