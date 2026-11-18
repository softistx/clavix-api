import type { IResolvers } from "@graphql-tools/utils";
import { denial } from "@softistx/janus-graphql";
import { oauthResolvers, oauthTypeDefs } from "@softistx/janus-oauth/graphql";
import type { Context } from "@/http/context";
import type { OAuthHandle } from "@/oauth/routes";
import { requireLive } from "@/tenancy/live";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import {
  type DetailTexts,
  type DetailTextsFor,
  detailsOf,
} from "./detail-labels";
import {
  localeOf,
  type ScopeTexts,
  type ScopeTextsFor,
  textOf,
} from "./scope-labels";

/** janus-oauth's consent SDL: `oauthRequest`, `approveOAuthRequest`, `denyOAuthRequest`, the device fields `oauthDeviceRequest`, `approveOAuthDeviceRequest`, `denyOAuthDeviceRequest`, `connectedApps`, `revokeConnectedApp`. */
export const consentTypeDefs = oauthTypeDefs;

// The OAuth servers the app serves: put on every context by `oauthContext`,
// read by the resolvers, which pick the request host's server.
const SERVERS = "oauthServers" as const;
type ServerSource = Required<Pick<OAuthHandle, "serverFor">>;
const TEXTS = "scopeTextsFor" as const;
const DETAIL_TEXTS = "detailTextsFor" as const;
type WithServers = {
  [SERVERS]?: ServerSource;
  [TEXTS]?: ScopeTextsFor;
  [DETAIL_TEXTS]?: DetailTextsFor;
};

/**
 * Puts the app's OAuth servers on the GraphQL context (`createApp({ oauth })`),
 * and the readers of the tenants' scope texts, which the consent page shows
 * instead of the bare scope names, and of their detail type texts, which it
 * shows as the request's `details`.
 */
export const oauthContext = (
  oauth: ServerSource,
  texts?: ScopeTextsFor,
  detailTexts?: DetailTextsFor,
) => ({
  onContextBuilding: ({
    extendContext,
  }: {
    extendContext: (extension: WithServers) => void;
  }) =>
    extendContext({
      [SERVERS]: oauth,
      ...(texts === undefined ? {} : { [TEXTS]: texts }),
      ...(detailTexts === undefined ? {} : { [DETAIL_TEXTS]: detailTexts }),
    }),
});

// One read of the tenant's texts per request, shared by the fields of a page.
function perRequest<T>() {
  const reads = new WeakMap<Request, Promise<T>>();
  return (
    request: Request | undefined,
    read: ((r: Request) => Promise<T>) | undefined,
  ) => {
    if (request === undefined || read === undefined) return undefined;
    let texts = reads.get(request);
    if (texts === undefined) {
      texts = read(request);
      reads.set(request, texts);
    }
    return texts;
  };
}
const readTexts = perRequest<ScopeTexts>();
const readDetailTexts = perRequest<DetailTexts>();
const textsOf = (ctx: WithServers & { request?: Request }) =>
  readTexts(ctx.request, ctx[TEXTS]);

// The details of a pending request or device request, in words (D5).
async function detailed(
  parent: { authorizationDetails?: string | null },
  _: unknown,
  ctx: WithServers & { request?: Request },
) {
  if (parent.authorizationDetails == null) return [];
  const texts = (await readDetailTexts(ctx.request, ctx[DETAIL_TEXTS])) ?? [];
  const locale = localeOf(ctx.request?.headers.get("accept-language") ?? null);
  return detailsOf(parent.authorizationDetails, texts, locale);
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
    // The device page's three fields: before each lookup of a user code, the
    // signed-in user, the client address and the tenant are counted (hit or
    // miss: janus calls the hook before it reads the store). The viewer is
    // known to be signed in, and the tenant live, when it runs.
    beforeUserCodeLookup: async (ctx) => {
      const { tenant, ip, deviceThrottle, janus } = ctx as unknown as Context;
      const [current, resolved] = await Promise.all([janus.user(), tenant()]);
      if (current === null || resolved === null) throw denial("NOT_FOUND");
      await deviceThrottle?.check({
        tenantId: resolved.tenantId,
        userId: current.id,
        ip,
      });
    },
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
  OAuthRequest: { scopes: labelled, details: detailed },
  OAuthDeviceRequest: { scopes: labelled, details: detailed },
  OAuthConnectedApp: { scopes: labelled },
};
