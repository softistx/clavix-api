import {
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_GRANT,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";

/**
 * The grant types Clavix offers. A client's `grantTypes` is enforced by janus-oauth on
 * `/authorize`, the code exchange, the refresh grant and the device grant
 * (`unauthorized_client`), and an explicit list is taken as written: a client
 * that refreshes lists `refresh_token` beside `authorization_code` or the
 * device URN. A list needs `authorization_code` or the device grant
 * (`refresh_token` alone is refused by janus). The device grant is never
 * implied: a client opts in. The token exchange grant (RFC 8693) is the same,
 * for a confidential client only, and it also needs the client's rules
 * (`clientPolicies`): with none, every exchange is refused. The client
 * credentials grant (RFC 6749 section 4.4) is the same: a confidential
 * client only, never implied, with the scopes it may ask for
 * (`allowedScopes`), and served only for a resource that opted in
 * (`allowClientCredentials`).
 */
export const OFFERED_GRANTS = [
  "authorization_code",
  "refresh_token",
  DEVICE_GRANT,
  TOKEN_EXCHANGE_GRANT,
  CLIENT_CREDENTIALS_GRANT,
] as const;
export type OfferedGrant = (typeof OFFERED_GRANTS)[number];

/** What a client with no recorded `grantTypes` may use (janus's default). */
export const DEFAULT_GRANTS = ["authorization_code", "refresh_token"] as const;

/** Whether a client with these grants goes through a browser redirect (it needs a redirect URI). */
export const usesRedirect = (grants: readonly string[] | undefined) =>
  grants === undefined || grants.includes("authorization_code");
