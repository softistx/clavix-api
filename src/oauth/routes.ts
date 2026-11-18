import type { OAuthIssuers } from "@softistx/janus-oauth";

// The paths janus's endpoints answer (its defaults, under the issuer's empty
// path): the authorization server's own, never the GraphQL or console routes.
export const OAUTH_PATHS = [
  "/authorize",
  "/par",
  "/device_authorization",
  "/token",
  "/register",
  "/revoke",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/jwks.json",
  "/userinfo",
  "/introspect",
] as const;

/** The slice of `OAuthIssuers` the app mounts. */
export type OAuthHandle = Partial<Pick<OAuthIssuers, "serverFor">> & {
  /** The endpoints; `ip` is the client address, which only the mount knows (the metadata fetch limits). */
  handle: (request: Request, ip?: string | undefined) => Promise<Response>;
  /** `/register` with the client address, which only the mount knows (`withRegistration`). */
  register?: (request: Request, ip: string | undefined) => Promise<Response>;
};

/**
 * Mounts the OAuth endpoints on an app: each path hands the plain `Request`
 * to the issuer of its host and sends the `Response` back (a host without
 * tenant is a 404 from `handle`).
 */
export function mountOAuth<
  A extends {
    all: (
      path: string,
      handler: (ctx: { request: Request; ip?: string | undefined }) => unknown,
    ) => A;
  },
>(app: A, oauth: OAuthHandle): A {
  let mounted = app;
  // Clavix's own `/register` (quota, throttle, record) when the handle has it;
  // a bare handle (a stand-in, or janus's own) serves it through `handle`.
  const { register } = oauth;
  for (const path of OAUTH_PATHS) {
    mounted =
      path === "/register" && register !== undefined
        ? mounted.all(path, ({ request, ip }) => register(request, ip))
        : mounted.all(path, ({ request, ip }) => oauth.handle(request, ip));
  }
  return mounted;
}
