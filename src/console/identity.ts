import type { PublicOrigin } from "@/modules/tenants/identity";

/** The console API's path on the graxia endpoint of `src/console`, apart from the hosted pages' `/graphql`. */
export const CONSOLE_PATH = "/console/graphql";

/** The audit export's path (D17), on the console host beside the GraphQL one. */
export const CONSOLE_EXPORT_PATH = "/console/audit/export";

/** The id of the console's OAuth client in the `clavix` tenant. */
export const CONSOLE_CLIENT_ID = "console";

/**
 * What the console asks for on its resource: `console` for the API, the
 * OpenID Connect ones so one authorization yields the id_token as well.
 */
export const CONSOLE_SCOPES = [
  "console",
  "openid",
  "profile",
  "email",
] as const;

/** `<scheme>://console.<domain>[:port]`, where the console UI is served. */
export const consoleOrigin = (origin: PublicOrigin) =>
  `${origin.scheme}://console.${origin.domain}${
    origin.port === undefined ? "" : `:${origin.port}`
  }`;

/**
 * The resource of the console API (RFC 8707): the `aud` of its access tokens,
 * `https://console.<CLAVIX_DOMAIN>/api`.
 */
export const consoleAudience = (origin: PublicOrigin) =>
  `${consoleOrigin(origin)}/api`;

/**
 * Where the console UI's OIDC callback lives (assumed until the UI slice
 * settles it; re-run `clients:create --client-id console` to change it).
 */
export const consoleRedirectUri = (origin: PublicOrigin) =>
  `${consoleOrigin(origin)}/console/auth/callback`;
