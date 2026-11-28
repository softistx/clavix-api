import type { LimixAlxiaOptions } from "@softistx/limix-alxia";
import type { LimixGraxiaOptions } from "@softistx/limix-graxia";
import { consoleContextOf } from "@/console/context";
import { consoleClaims, hostedClaims } from "./claims";
import { consolePolicy, hostedPolicy, restPolicyFor } from "./policy";
import { mapRefusal } from "./refusal";
import { consoleRelations } from "./relations";

/**
 * What guards the hosted `/graphql`: its fields answer to `hostedPolicy`, for
 * the user of the session cookie. A non-null root field (`health`) is let
 * through: the rule's refusal would null its parent, and each is public.
 */
export const hostedLimix: LimixGraxiaOptions<object> = {
  policy: hostedPolicy,
  claims: hostedClaims,
  mapRefusal,
  nonNull: "allow",
};

/** What guards `/console/graphql`: `consolePolicy`, for the token's user, relations on `ctx.can`. */
export const consoleLimix: LimixGraxiaOptions<object> = {
  policy: consolePolicy,
  claims: consoleClaims,
  relations: (ctx) => consoleRelations(consoleContextOf(ctx)),
  mapRefusal,
  nonNull: "allow",
};

/** The REST guard's options for `app` (the routes it judges): every route is public, see `rest.rules.ts`. */
export const restLimix = (
  app: LimixAlxiaOptions["app"],
  mounted: { oauth: boolean; console: boolean },
): LimixAlxiaOptions => ({
  policy: restPolicyFor(mounted),
  claims: () => ({ authenticated: false }),
  app,
});
