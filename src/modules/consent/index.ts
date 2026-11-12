import type { IResolvers } from "@graphql-tools/utils";
import { denial } from "@softistx/janus-graphql";
import { oauthResolvers, oauthTypeDefs } from "@softistx/janus-oauth/graphql";
import type { OAuthHandle } from "@/oauth/routes";

/** janus-oauth's consent SDL: `oauthRequest`, `approveOAuthRequest`, `denyOAuthRequest`, `connectedApps`, `revokeConnectedApp`. */
export const consentTypeDefs = oauthTypeDefs;

// The OAuth servers the app serves: put on every context by `oauthContext`,
// read by the resolvers, which pick the request host's server.
const SERVERS = "oauthServers" as const;
type ServerSource = Required<Pick<OAuthHandle, "serverFor">>;
type WithServers = { [SERVERS]?: ServerSource };

/** Puts the app's OAuth servers on the GraphQL context (`createApp({ oauth })`). */
export const oauthContext = (oauth: ServerSource) => ({
  onContextBuilding: ({
    extendContext,
  }: {
    extendContext: (extension: WithServers) => void;
  }) => extendContext({ [SERVERS]: oauth }),
});

const requestOf = (ctx: unknown): Request => {
  const { request } = ctx as { request?: Request };
  if (request === undefined) throw denial("NOT_FOUND");
  return request;
};

// The cookie is the credential and a sibling tenant host is same-site (SameSite=Lax does not stop
// it), so a request that decides or reads a consent must come from the tenant's own origin and as
// JSON (not a CORS "simple" form post). Anything else sees no such request.
// `Origin: null` (a sandboxed frame) and other junk have no host: they never match.
const hostOf = (value: string): string | null => {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

export function sameOriginJson(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Hosts, not origins: behind a TLS-terminating proxy `request.url` may say http while the
  // browser's Origin says https. A request with no Origin (not a browser) passes; the cookie is `__Host-`.
  if (origin !== null && hostOf(origin) !== hostOf(request.url)) return false;
  return (
    request.method !== "POST" ||
    (request.headers.get("content-type") ?? "").startsWith("application/json")
  );
}

/**
 * The consent API of the hosted `/consent` page, on `/graphql`. Both the OAuth
 * server and the signed-in user (`janusPlugin`) are the request host's tenant's,
 * so a request id or a session of another tenant is unknown there.
 * `approveOAuthRequest` needs a session younger than five minutes
 * (`STEP_UP_REQUIRED`); `authTime` is the session's sign-in time; janus-oauth's
 * resolvers pass no `amr` or `acr`.
 */
export const consentResolvers: IResolvers = {
  ...oauthResolvers({
    oauth: async (ctx) => {
      // Every consent operation (read, decide, list and revoke connected apps) passes the guard here.
      const request = requestOf(ctx);
      if (!sameOriginJson(request)) throw denial("NOT_FOUND");
      const server = await (ctx as WithServers)[SERVERS]?.serverFor(request);
      if (server === null || server === undefined) throw denial("NOT_FOUND");
      return server;
    },
    ownsRequest: (_viewer, _request, ctx) => sameOriginJson(requestOf(ctx)),
  }),
};
