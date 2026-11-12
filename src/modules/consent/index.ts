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
export function sameOriginJson(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) return false;
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
      const servers = (ctx as WithServers)[SERVERS];
      const server = await servers?.serverFor(requestOf(ctx));
      if (server === null || server === undefined) throw denial("NOT_FOUND");
      return server;
    },
    ownsRequest: (_viewer, _request, ctx) => sameOriginJson(requestOf(ctx)),
  }),
};
