import type { IResolvers } from "@graphql-tools/utils";
import { denial } from "@softistx/janus-graphql";
import { oauthResolvers, oauthTypeDefs } from "@softistx/janus-oauth/graphql";
import { GraphQLError } from "graphql";
import type { Context } from "@/http/context";
import type { OAuthHandle } from "@/oauth/routes";
import { requireLive } from "@/tenancy/live";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { type AgentMarks, type AgentsFor, markOf } from "./agent-marker";
import {
  type DetailTexts,
  type DetailTextsFor,
  reviewDetails,
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
const AGENTS = "agentsFor" as const;
type WithServers = {
  [SERVERS]?: ServerSource;
  [TEXTS]?: ScopeTextsFor;
  [DETAIL_TEXTS]?: DetailTextsFor;
  [AGENTS]?: AgentsFor;
};

/**
 * Puts the app's OAuth servers on the GraphQL context (`createApp({ oauth })`),
 * and the readers of the tenants' scope texts, which the consent page shows
 * instead of the bare scope names, and of their detail type texts, which it
 * shows as the request's `details`, and of the tenant's agents, which marks
 * a client as an agent.
 */
export const oauthContext = (
  oauth: ServerSource,
  texts?: ScopeTextsFor,
  detailTexts?: DetailTextsFor,
  agents?: AgentsFor,
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
      ...(agents === undefined ? {} : { [AGENTS]: agents }),
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
const readAgents = perRequest<AgentMarks>();
const textsOf = (ctx: WithServers & { request?: Request }) =>
  readTexts(ctx.request, ctx[TEXTS]);

// The details of a pending request or device request, in words (D5), and
// whether every one is fully described.
async function reviewed(
  authorizationDetails: string | null | undefined,
  ctx: WithServers & { request?: Request },
) {
  const texts = (await readDetailTexts(ctx.request, ctx[DETAIL_TEXTS])) ?? [];
  const locale = localeOf(ctx.request?.headers.get("accept-language") ?? null);
  return reviewDetails(authorizationDetails ?? null, texts, locale);
}
const detailed = async (
  parent: { authorizationDetails?: string | null },
  _: unknown,
  ctx: WithServers & { request?: Request },
) => (await reviewed(parent.authorizationDetails, ctx)).details;
const detailsComplete = async (
  parent: { authorizationDetails?: string | null },
  _: unknown,
  ctx: WithServers & { request?: Request },
) => (await reviewed(parent.authorizationDetails, ctx)).complete;

// janus counts the device user-code lookups (`beforeUserCodeLookup`); the
// approve guard below looks the code up first, so it counts it itself and
// tells janus's hook not to count the same call twice.
const counted = new WeakSet<object>();

// Approval is all or nothing (D4) and allows only what the page showed: a
// request whose details cannot be fully described (type deleted, a key the
// type no longer defines) is refused before janus approves it, as an invalid
// authorization details input; it stays pending and can be denied. janus-oauth
// has no hook before an approval, so the guard wraps its two approve resolvers.
type Resolver = (...args: never[]) => Promise<unknown>;
const refuseIncomplete = () =>
  new GraphQLError("invalid_authorization_details", {
    extensions: {
      code: "BAD_USER_INPUT",
      oauthError: "invalid_authorization_details",
    },
  });
const signedIn = async (ctx: unknown) =>
  (await (ctx as Context).janus.user()) !== null;

function guardCode(approve: Resolver): Resolver {
  return async (...args) => {
    const [, { id }, ctx] = args as unknown as [
      unknown,
      { id: string },
      WithServers & { request?: Request },
    ];
    // Anonymous, or unknown to this tenant: janus answers as it always did.
    if (ctx.request !== undefined && (await signedIn(ctx))) {
      const server = await ctx[SERVERS]?.serverFor(ctx.request);
      const view = await server?.request(id);
      if (view?.authorizationDetails !== undefined) {
        const json = JSON.stringify(view.authorizationDetails);
        if (!(await reviewed(json, ctx)).complete) throw refuseIncomplete();
      }
    }
    return approve(...args);
  };
}

function guardDevice(
  approve: Resolver,
  beforeLookup: (ctx: never) => Promise<void>,
): Resolver {
  return async (...args) => {
    const [, { userCode }, ctx] = args as unknown as [
      unknown,
      { userCode: string },
      WithServers & { request?: Request },
    ];
    if (ctx.request !== undefined && (await signedIn(ctx))) {
      const server = await ctx[SERVERS]?.serverFor(ctx.request);
      if (server !== null && server !== undefined) {
        await beforeLookup(ctx as never);
        counted.add(ctx);
        const view = await server.deviceRequest(userCode);
        if (view?.authorizationDetails !== undefined) {
          const json = JSON.stringify(view.authorizationDetails);
          if (!(await reviewed(json, ctx)).complete) throw refuseIncomplete();
        }
      }
    }
    return approve(...args);
  };
}

// One read of the tenant's agents per request, shared by every client of a page.
const agentOf = async (
  parent: { id: string },
  ctx: WithServers & { request?: Request },
) => markOf(await readAgents(ctx.request, ctx[AGENTS]), parent.id);

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

const countLookup = async (ctx: Context) => {
  const { tenant, ip, deviceThrottle, janus } = ctx;
  const [current, resolved] = await Promise.all([janus.user(), tenant()]);
  if (current === null || resolved === null) throw denial("NOT_FOUND");
  await deviceThrottle?.check({
    tenantId: resolved.tenantId,
    userId: current.id,
    ip,
  });
};

const janusResolvers = oauthResolvers({
  // The device page's three fields: before each lookup of a user code, the
  // signed-in user, the client address and the tenant are counted (hit or
  // miss: janus calls the hook before it reads the store). The viewer is
  // known to be signed in, and the tenant live, when it runs.
  beforeUserCodeLookup: async (ctx) => {
    if (counted.delete(ctx)) return;
    await countLookup(ctx as unknown as Context);
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
});

/**
 * The consent API of the hosted `/consent` page, on `/graphql`. Both the OAuth
 * server and the signed-in user (`janusPlugin`) are the request host's tenant's,
 * so a request id or a session of another tenant is unknown there.
 * `approveOAuthRequest` needs a session younger than five minutes
 * (`STEP_UP_REQUIRED`); `authTime` is the session's sign-in time; janus-oauth's
 * resolvers pass no `amr` or `acr`.
 */
export const consentResolvers: IResolvers = {
  ...janusResolvers,
  Mutation: {
    ...janusResolvers.Mutation,
    approveOAuthRequest: guardCode(
      janusResolvers.Mutation["approveOAuthRequest"] as Resolver,
    ),
    approveOAuthDeviceRequest: guardDevice(
      janusResolvers.Mutation["approveOAuthDeviceRequest"] as Resolver,
      countLookup as (ctx: never) => Promise<void>,
    ),
  },
  // The label of a scope is the tenant's description of it (console, `Scope`),
  // in the viewer's language (`Accept-Language`); janus's own (the scope's
  // name) when the tenant wrote none. janus-oauth's `scopeLabels` is one
  // static map, not per tenant, resource and language, hence these two fields.
  OAuthRequest: { scopes: labelled, details: detailed, detailsComplete },
  OAuthDeviceRequest: { scopes: labelled, details: detailed, detailsComplete },
  OAuthConnectedApp: { scopes: labelled },
  // Whether the client is an agent of the tenant, and since when.
  OAuthClient: {
    agent: async (parent: { id: string }, _: unknown, ctx: WithServers) =>
      (await agentOf(parent, ctx)).agent,
    registeredAt: async (
      parent: { id: string },
      _: unknown,
      ctx: WithServers,
    ) => (await agentOf(parent, ctx)).registeredAt,
  },
};
