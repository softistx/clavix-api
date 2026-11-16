import type { OAuthIssuers } from "@softistx/janus-oauth";

// The paths janus's endpoints answer (its defaults, under the issuer's empty
// path): the authorization server's own, never the GraphQL or console routes.
export const OAUTH_PATHS = [
  "/authorize",
  "/par",
  "/token",
  "/revoke",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/jwks.json",
  "/userinfo",
  "/introspect",
] as const;

/** The slice of `OAuthIssuers` the app mounts. */
export type OAuthHandle = Pick<OAuthIssuers, "handle"> &
  Partial<Pick<OAuthIssuers, "serverFor">>;

/**
 * Mounts the OAuth endpoints on an app: each path hands the plain `Request`
 * to the issuer of its host and sends the `Response` back (a host without
 * tenant is a 404 from `handle`).
 */
export function mountOAuth<
  A extends {
    all: (path: string, handler: (ctx: { request: Request }) => unknown) => A;
  },
>(app: A, oauth: OAuthHandle): A {
  let mounted = app;
  for (const path of OAUTH_PATHS) {
    mounted = mounted.all(path, ({ request }) => oauth.handle(request));
  }
  return mounted;
}
