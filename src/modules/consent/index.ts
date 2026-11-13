import type { IResolvers } from "@graphql-tools/utils";
import { denial } from "@softistx/janus-graphql";
import { oauthResolvers, oauthTypeDefs } from "@softistx/janus-oauth/graphql";
import type { OAuthHandle } from "@/oauth/routes";
import { requireLive } from "@/tenancy/live";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import {
  localeOf,
  type ScopeTexts,
  type ScopeTextsFor,
  textOf,
} from "./scope-labels";

/** janus-oauth's consent SDL: `oauthRequest`, `approveOAuthRequest`, `denyOAuthRequest`, `connectedApps`, `revokeConnectedApp`. */
export const consentTypeDefs = oauthTypeDefs;

// The OAuth servers the app serves: put on every context by `oauthContext`,
// read by the resolvers, which pick the request host's server.
const SERVERS = "oauthServers" as const;
type ServerSource = Required<Pick<OAuthHandle, "serverFor">>;
const TEXTS = "scopeTextsFor" as const;
type WithServers = {
  [SERVERS]?: ServerSource;
  [TEXTS]?: ScopeTextsFor;
};

/**
 * Puts the app's OAuth servers on the GraphQL context (`createApp({ oauth })`),
 * and the reader of the tenants' scope texts, which the consent page shows
 * instead of the bare scope names.
 */
export const oauthContext = (oauth: ServerSource, texts?: ScopeTextsFor) => ({
  onContextBuilding: ({
    extendContext,
  }: {
    extendContext: (extension: WithServers) => void;
  }) =>
    extendContext({
      [SERVERS]: oauth,
      ...(texts === undefined ? {} : { [TEXTS]: texts }),
    }),
});

// One read of the tenant's texts per request, shared by the scopes of a page.
const readTexts = new WeakMap<Request, Promise<ScopeTexts>>();
function textsOf(ctx: WithServers & { request?: Request }) {
  const { request } = ctx;
  const read = ctx[TEXTS];
  if (request === undefined || read === undefined) return undefined;
  let texts = readTexts.get(request);
  if (texts === undefined) {
    texts = read(request);
    readTexts.set(request, texts);
  }
  return texts;
}

interface Labelled {
  name: string;
  label: string;
}

// The scopes of a pending request or of a connected app, relabelled.
async function labelled(
  parent: { resource: string; scopes: Labelled[] },
  _: unknown,
  ctx: WithServers & { request?: Request },
): Promise<Labelled[]> {
  const texts = await textsOf(ctx);
  if (texts === undefined) return parent.scopes;
  const locale = localeOf(ctx.request?.headers.get("accept-language") ?? null);
  return parent.scopes.map((scope) => ({
    name: scope.name,
    label:
      textOf(texts, { name: scope.name, resource: parent.resource }, locale) ??
      scope.label,
  }));
}

const requestOf = (ctx: unknown): Request => {
  const { request } = ctx as { request?: Request };
  if (request === undefined) throw denial("NOT_FOUND");
  return request;
};

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
      // The same-origin guard ran at the HTTP layer (`useSameOriginJson`, src/http/same-origin.ts).
      const request = requestOf(ctx);
      const server = await (ctx as WithServers)[SERVERS]?.serverFor(request);
      if (server === null || server === undefined) throw denial("NOT_FOUND");
      // A code is not minted for a suspended or deleted tenant.
      requireLive(
        await (
          ctx as unknown as { tenant: () => Promise<ResolvedTenant> }
        ).tenant(),
      );
      return server;
    },
  }),
  // The label of a scope is the tenant's description of it (console, `Scope`),
  // in the viewer's language (`Accept-Language`); janus's own (the scope's
  // name) when the tenant wrote none. janus-oauth's `scopeLabels` is one
  // static map, not per tenant, resource and language, hence these two fields.
  OAuthRequest: { scopes: labelled },
  OAuthConnectedApp: { scopes: labelled },
};
