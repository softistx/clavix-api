import type { OAuthLifetimes } from "@softistx/janus-oauth";

/**
 * Token lifetimes of every issuer. Assumed owner decision (clavix-api#24,
 * plan comment): access token 15 minutes; refresh token 30 days sliding,
 * capped at 90 days from the first token of the chain.
 */
export const lifetimes: OAuthLifetimes = {
  accessToken: "15m",
  refreshToken: "30d",
  refreshTokenMax: "90d",
};
