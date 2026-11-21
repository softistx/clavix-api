import type { Resolvers } from "@/generated/graphql/resolvers";
import { REPLACED_REASON, recordingSignIn } from "@/modules/auth";
import { requireLive } from "@/tenancy/live";
import {
  completedAnswer,
  hostedMethods,
  requireOfferedProvider,
  socialOfTenant,
  tenantOf,
} from "./sign-in-methods.resolver-support";

export const signInMethods: Resolvers = {
  Query: {
    hostedSignInMethods: async (_, __, ctx) =>
      hostedMethods(await tenantOf(ctx)),
  },
  Mutation: {
    socialSignInStart: async (_, { provider, returnTo }, ctx) => {
      // The tenant's policy first: a provider it does not offer does not
      // exist, before any throttle budget is spent.
      const tenant = await tenantOf(ctx);
      requireLive(tenant);
      await requireOfferedProvider(tenant, provider);
      const { resolvers } = await socialOfTenant(ctx);
      await ctx.ssoStartThrottle.check({
        tenantId: tenant.tenantId,
        ip: ctx.ip,
      });
      return resolvers.Mutation.socialSignInStart(
        _,
        { provider, returnTo: returnTo ?? null },
        ctx,
      );
    },
    // No throttle of its own, on purpose: the budget is spent at
    // `socialSignInStart`, and a flow is an unguessable single-use token that
    // janus redeems before it calls the provider. A replayed or made-up flow
    // is refused with no provider call (sign-in-methods.resolver.spec.ts), so
    // this mutation cannot be used to spend the provider's quota.
    socialSignInComplete: async (_, { callbackUrl, flow }, ctx) => {
      const tenant = await tenantOf(ctx);
      requireLive(tenant);
      const { auth, resolvers } = await socialOfTenant(ctx);
      const done = await recordingSignIn(
        ctx,
        tenant.tenantId,
        "social",
        () =>
          resolvers.Mutation.socialSignInComplete(
            _,
            { callbackUrl, flow },
            ctx,
          ),
        (completed) =>
          completed.status === "signedIn" ? completed.userId : null,
        (completed) =>
          completed.status === "signedIn" && completed.replaced
            ? REPLACED_REASON
            : undefined,
      );
      ctx.set.headers.set("cache-control", "no-store");
      return completedAnswer(ctx, tenant.tenantId, auth, done);
    },
  },
};
