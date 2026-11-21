import type { IResolvers } from "@graphql-tools/utils";
import { oauthResolvers, oauthTypeDefs } from "@softistx/janus-oauth/graphql";
import type { Context } from "@/http/context";
import { services } from "@/modules/services";
import type { RequestDemands } from "./consent.authentication";
import type { ConsentCtx, Detailed, LabelledScope } from "./consent.types";

/** janus-oauth's consent SDL: `oauthRequest`, `approveOAuthRequest`, `denyOAuthRequest`, the device fields `oauthDeviceRequest`, `approveOAuthDeviceRequest`, `denyOAuthDeviceRequest`, `connectedApps`, `revokeConnectedApp`. */
export const consentTypeDefs = oauthTypeDefs;

const janusResolvers = oauthResolvers({
  beforeUserCodeLookup: (ctx) => services().consent.countLookup(ctx),
  beforeApprove: (args, ctx) => services().consent.beforeApprove(args, ctx),
  approveOptions: (args, ctx) => services().consent.approveOptions(args, ctx),
  oauth: (ctx) => services().consent.serverOf(ctx),
});

type Scoped = { resource: string; scopes: LabelledScope[] };

// The label of a scope is the tenant's description of it (console, `Scope`),
// in the viewer's language (`Accept-Language`); janus's own (the scope's
// name) when the tenant wrote none. janus-oauth's `scopeLabels` is one
// static map, not per tenant, resource and language, hence these fields.
const requestFields = {
  scopes: (parent: Scoped, _: unknown, ctx: ConsentCtx) =>
    services().consent.scopes(parent, ctx),
  details: (parent: Detailed, _: unknown, ctx: ConsentCtx) =>
    services().consent.details(parent, ctx),
  detailsComplete: (parent: Detailed, _: unknown, ctx: ConsentCtx) =>
    services().consent.detailsComplete(parent, ctx),
  authentication: (parent: RequestDemands, _: unknown, ctx: Context) =>
    services().consent.authentication(parent, ctx),
};

/**
 * The consent API of the hosted `/consent` page, on `/graphql`.
 * `approveOAuthRequest` needs a session younger than five minutes
 * (`STEP_UP_REQUIRED`) and refuses an approval the session's authentication
 * does not meet (`UNMET_AUTHENTICATION_REQUIREMENTS`).
 */
export const consentResolvers: IResolvers = {
  ...janusResolvers,
  Mutation: {
    ...janusResolvers.Mutation,
    approveOAuthRequest: (
      parent: unknown,
      args: { id: string },
      ctx: unknown,
      info: unknown,
    ) => {
      const approve = janusResolvers.Mutation?.["approveOAuthRequest"] as (
        ...rest: unknown[]
      ) => Promise<{ redirectTo: string }>;
      return services().consent.approveOrDenyUnmet(
        () => approve(parent, args, ctx, info),
        args.id,
        ctx,
      );
    },
  },
  OAuthRequest: requestFields,
  OAuthDeviceRequest: requestFields,
  OAuthConnectedApp: { scopes: requestFields.scopes },
  // Whether the client is an agent of the tenant, and since when.
  OAuthClient: {
    agent: async (parent: { id: string }, _: unknown, ctx: ConsentCtx) =>
      (await services().consent.agent(parent, ctx)).agent,
    registeredAt: async (parent: { id: string }, _: unknown, ctx: ConsentCtx) =>
      (await services().consent.agent(parent, ctx)).registeredAt,
  },
};
