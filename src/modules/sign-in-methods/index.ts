import { denial, socialResolvers } from "@softistx/janus-graphql";
import { connectionsService } from "@/config/connections";
import { secretBox } from "@/config/keys";
import { usageService } from "@/config/usage";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";
import { recordingSignIn } from "@/modules/auth/sign-in-events";
import { challengeAnswer } from "@/modules/mfa/challenge";
import { requireLive } from "@/tenancy/live";
import { socialOf } from "@/users/tenant-janus";
import { methodDisabled } from "./gate";
import {
  type MethodType,
  methodsOf,
  offeredSocial,
  SOCIAL_LABELS,
} from "./sign-in.schema";

const HOSTED = {
  passkey: "PASSKEY",
  emailCode: "EMAIL_CODE",
  magicLink: "MAGIC_LINK",
  password: "PASSWORD",
} as const satisfies Record<MethodType, string>;

async function tenantOf(ctx: Context) {
  const tenant = await ctx.tenant();
  if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
  return tenant;
}

// The tenant's janus instance, resolved once per request: the mutation's own
// checks and janus's per-field `auth` call share it. Keyed on the request, never
// on an instance, so a provider changed between two requests is read afresh.
const resolved = new WeakMap<
  Request,
  Promise<Awaited<ReturnType<typeof janusIssuers.forRequest>>>
>();
const authOf = (request: Request) => {
  let found = resolved.get(request);
  if (found === undefined) {
    found = janusIssuers.forRequest(request);
    resolved.set(request, found);
  }
  return found;
};

// The social sign-in is janus-graphql's (`socialResolvers`): the flow, the
// account link, the session cookie and the `no-store` header are janus's. The
// auth source is a per-request function, called on every social field: it
// returns the instance of the tenant the host names, or null when there is
// none or it has no social provider (janus answers UNAUTHENTICATED).
const social = socialResolvers({
  auth: async (ctx) => {
    if (ctx.request === undefined) return null;
    const auth = await authOf(ctx.request);
    return auth === null ? null : socialOf(auth);
  },
});

/**
 * The tenant's social instance; `SIGN_IN_METHOD_DISABLED` for a tenant with no
 * social provider. The instance also carries the tenant's enterprise
 * connections (every tenant has the resolver): the surface is open when the
 * tenant offers a static social app or has a connection, and refused as before
 * otherwise.
 */
async function socialOfTenant(ctx: Context) {
  const auth = await authOf(ctx.request);
  if (auth === null) throw denial("NOT_FOUND", "No such tenant");
  const instance = socialOf(auth);
  if (instance === null) throw methodDisabled("social");
  const { signIn, tenantId } = await tenantOf(ctx);
  if (
    offeredSocial(signIn, secretBox.opens).length === 0 &&
    (await connectionsService.count(tenantId)) === 0
  ) {
    throw methodDisabled("social");
  }
  return { auth: instance, resolvers: social };
}

export const signInMethods: Resolvers = {
  Query: {
    hostedSignInMethods: async (_, __, ctx) => {
      const { signIn } = await tenantOf(ctx);
      return {
        methods: methodsOf(signIn)
          .filter((method) => method.enabled)
          .map((method) => HOSTED[method.type]),
        social: offeredSocial(signIn, secretBox.opens).map(({ provider }) => ({
          id: provider,
          label: SOCIAL_LABELS[provider],
        })),
      };
    },
  },
  Mutation: {
    socialSignInStart: async (_, { provider, returnTo }, ctx) => {
      // The tenant's policy first: a provider it does not offer does not
      // exist, before any throttle budget is spent.
      const tenant = await tenantOf(ctx);
      requireLive(tenant);
      const offered = offeredSocial(tenant.signIn, secretBox.opens);
      if (!offered.some((entry) => entry.provider === provider)) {
        // Not one of the tenant's static apps: an enabled enterprise
        // connection of the tenant (its id is the provider name). A fixed
        // word: the caller's string is not echoed.
        const connection = await connectionsService.find(
          tenant.tenantId,
          provider,
        );
        if (connection === undefined || !connection.enabled) {
          throw methodDisabled("this provider");
        }
      }
      const { resolvers } = await socialOfTenant(ctx);
      await ctx.signInThrottle?.check({
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
    // is refused with no provider call (sign-in-methods.spec.ts), so this
    // mutation cannot be used to spend the provider's quota.
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
      );
      ctx.set.headers.set("cache-control", "no-store");
      if (done.status === "secondFactor") {
        return challengeAnswer(done, done.returnTo);
      }
      // Nothing here starts a link flow: a completed flow is a sign-in.
      if (done.status !== "signedIn") {
        throw denial("FORBIDDEN", "Sign-in could not be completed");
      }
      // janus types the user as an id and a type only: read the profile.
      const user = await auth.findUser(done.userId);
      if (user === null) {
        throw denial("FORBIDDEN", "Sign-in could not be completed");
      }
      await usageService.recordActive(tenant.tenantId, user.id);
      return {
        __typename: "SocialSignedIn" as const,
        user: {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          emailVerified: user.emailVerified,
        },
        expiresAt: done.expiresAt,
        created: done.created,
        returnTo: done.returnTo,
      };
    },
  },
};
