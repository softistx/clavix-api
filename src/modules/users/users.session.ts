/** Host-only, `__Host-` prefixed: no Domain, Secure, Path=/ (janus's defaults), so a browser never sends it to another host. */
export const SESSION_COOKIE = "__Host-clavix-session";

/**
 * Assumed (owner decisions of 2026-11-12, clavix-api#24): 14 days sliding,
 * renewed once a day, and never more than 30 days after sign-in (`absolute`).
 */
export const SESSION = {
  lifespan: "14d",
  renewAfter: "1d",
  absolute: "30d",
} as const;

/** How long a sign-in code, and its challenge, can be confirmed (janus's default, stated). */
export const SIGN_IN_CODE_LIFESPAN = "10m";

/** How long a sign-in link can be confirmed (janus's default, stated). */
export const MAGIC_LINK_LIFESPAN = "15m";
