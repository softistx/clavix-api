import {
  denial,
  janusMaskError,
  janusTypeDefs,
  useJanus,
} from "@softistx/janus-graphql";
import type { OAuthIssuers } from "@softistx/janus-oauth";
import { oauthResolvers, oauthTypeDefs } from "@softistx/janus-oauth/graphql";
import type { createTenantJanusIssuers } from "@/users/tenant-janus";

export interface ConsentOptions {
  /** The OAuth servers, one per tenant: the request's host picks the server. */
  issuers: Pick<OAuthIssuers, "serverFor">;
  /** The janus instances, one per tenant: the request's host picks the session's pool. */
  janusIssuers: Pick<ReturnType<typeof createTenantJanusIssuers>, "forRequest">;
}

// janus-oauth's SDL extends `Query` and `Mutation`; this is their base until
// the sign-in surface (slice E1) owns the one GraphQL server that adds them.
const base = /* GraphQL */ `
  type Query { _consent: Boolean }
  type Mutation { _consent: Boolean }
`;

/**
 * The consent API of the hosted page (`/consent`): `oauthRequest`,
 * `approveOAuthRequest`, `denyOAuthRequest`, `connectedApps` and
 * `revokeConnectedApp`, as parts to put in a GraphQL server. Both the OAuth
 * server and the signed-in user are the request's own tenant's, so a request
 * id or a session of another tenant is unknown there.
 *
 * `approveOAuthRequest` needs a session younger than five minutes
 * (`STEP_UP_REQUIRED`, 403, otherwise); `authTime` is the session's sign-in
 * time. janus-oauth's resolvers pass no `amr` or `acr`.
 */
// The request Yoga puts on every context; a context without one has no host to pick a tenant by.
const requestOf = (ctx: unknown): Request => {
  const { request } = ctx as { request?: Request };
  if (request === undefined) throw denial("NOT_FOUND");
  return request;
};

export function consentGraphQL({ issuers, janusIssuers }: ConsentOptions) {
  return {
    typeDefs: [janusTypeDefs, oauthTypeDefs, base],
    resolvers: {
      ...oauthResolvers({
        oauth: async (ctx) => {
          const server = await issuers.serverFor(requestOf(ctx));
          if (server === null) throw denial("NOT_FOUND");
          return server;
        },
      }),
    },
    plugins: [
      useJanus({ auth: (ctx) => janusIssuers.forRequest(requestOf(ctx)) }),
    ],
    maskedErrors: { maskError: janusMaskError() },
  };
}
