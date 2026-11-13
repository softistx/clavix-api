import { denial, socialResolvers } from "@softistx/janus-graphql";
import { secretBox } from "@/config/keys";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";
import { socialOf, type TenantJanus } from "@/users/tenant-janus";
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

// The social sign-in is janus-graphql's (`socialResolvers`): the flow, the
// account link, the session cookie and the `no-store` header are janus's. Its
// resolvers take one instance, and each tenant has its own (rebuilt when its
// policy changes), so they are made once per instance. Upstream need, to be
// filed on nxgt-janus: `socialResolvers` taking a per-request auth source, as
// `passkeyResolvers` does; this map goes then.
const made = new WeakMap<TenantJanus, ReturnType<typeof socialResolvers>>();

/** janus-graphql's social resolvers on the tenant's instance; `SIGN_IN_METHOD_DISABLED` for a tenant with no social provider. */
async function socialOfTenant(ctx: Context) {
  const auth = await janusIssuers.forRequest(ctx.request);
  if (auth === null) throw denial("NOT_FOUND", "No such tenant");
  const social = socialOf(auth);
  if (social === null) throw methodDisabled("social");
  let resolvers = made.get(social);
  if (resolvers === undefined) {
    resolvers = socialResolvers({ auth: social });
    made.set(social, resolvers);
  }
  return { auth: social, resolvers };
}

export const signInMethods: Resolvers = {
  Query: {
    hostedSignInMethods: async (_, __, ctx) => {
      const { signIn } = await tenantOf(ctx);
      return {
        methods: methodsOf(signIn)
          .filter((method) => method.enabled)
          .map((method) => HOSTED[method.type]),
        social: offeredSocial(signIn, secretBox.kid).map(({ provider }) => ({
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
      const offered = offeredSocial(tenant.signIn, secretBox.kid);
      if (!offered.some((entry) => entry.provider === provider)) {
        // A fixed word: the caller's string is not echoed.
        throw methodDisabled("this provider");
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
    socialSignInComplete: async (_, { callbackUrl, flow }, ctx) => {
      await tenantOf(ctx);
      const { auth, resolvers } = await socialOfTenant(ctx);
      const done = await resolvers.Mutation.socialSignInComplete(
        _,
        { callbackUrl, flow },
        ctx,
      );
      // No second factor is configured and nothing starts a link flow: a
      // completed flow is a sign-in.
      if (done.status !== "signedIn") {
        throw denial("FORBIDDEN", "Sign-in could not be completed");
      }
      // janus types the user as an id and a type only: read the profile.
      const user = await auth.findUser(done.userId);
      if (user === null) {
        throw denial("FORBIDDEN", "Sign-in could not be completed");
      }
      return {
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
