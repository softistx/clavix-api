import { denial, passkeyResolvers } from "@softistx/janus-graphql";
import { usageService } from "@/config/usage";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";
import { recordingSignIn } from "@/modules/auth/sign-in-events";
import { requireMethod } from "@/modules/sign-in-methods/gate";
import { requireLive } from "@/tenancy/live";
import {
  asPasskeyInvalid,
  currentOf,
  passkeyInvalid,
  passkeyOut,
  responseOf,
} from "./passkeys";

// The passkey sign-in is janus-graphql's (`passkeyResolvers` with `firstFactor`):
// the operations below keep this API's own names, arguments and errors and call
// its resolvers, so the challenge, the assertion check and the session cookie
// are janus's. The management operations are written on `auth.passkeys`
// (docs/guide/passkeys.md of @softistx/janus).
async function authOf(ctx: Context) {
  const [auth, tenant] = await Promise.all([
    janusIssuers.forRequest(ctx.request),
    ctx.tenant(),
  ]);
  if (auth === null || tenant === null) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  return auth;
}

const janusPasskeys = passkeyResolvers({ auth: authOf, firstFactor: true });
const signInOptions = janusPasskeys.Query.passkeySignInOptions;
const passkeySignIn = janusPasskeys.Mutation.passkeySignIn;

export const passkeys: Resolvers = {
  Query: {
    myPasskeys: async (_, __, ctx) => {
      const auth = await authOf(ctx);
      const { user } = await currentOf(auth, ctx.request);
      return (await auth.passkeys.list(user)).map(passkeyOut);
    },
  },
  Mutation: {
    passkeySignInOptions: async (_, __, ctx) => {
      // The tenant first: a host that names none is a NOT_FOUND before any
      // throttle budget is spent. The key is the client address and the tenant.
      const tenant = await ctx.tenant();
      if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
      requireLive(tenant);
      requireMethod(tenant, "passkey");
      await ctx.passkeyThrottle?.check({
        tenantId: tenant.tenantId,
        ip: ctx.ip,
      });
      return signInOptions(_, __, ctx);
    },
    signInWithPasskey: async (_, { challenge, response }, ctx) => {
      const tenant = await ctx.tenant();
      if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
      requireLive(tenant);
      requireMethod(tenant, "passkey");
      const signedIn = await recordingSignIn(
        ctx,
        tenant.tenantId,
        "passkey",
        () =>
          asPasskeyInvalid(() =>
            passkeySignIn(_, { challenge, assertion: response }, ctx),
          ),
        (done) => done.userId,
      );
      // janus types `signedIn.user` as an id and a type only: read the profile.
      const auth = await authOf(ctx);
      const user = await auth.findUser(signedIn.userId);
      if (user === null) throw passkeyInvalid();
      await usageService.recordActive(tenant.tenantId, user.id);
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          emailVerified: user.emailVerified,
        },
        expiresAt: signedIn.expiresAt,
      };
    },
    passkeyRegistrationOptions: async (_, __, ctx) => {
      const auth = await authOf(ctx);
      const { user } = await currentOf(auth, ctx.request);
      const issued = await auth.passkeys.registrationOptions(user);
      ctx.set.headers.set("cache-control", "no-store");
      return {
        options: JSON.stringify(issued.options),
        challenge: issued.challenge,
        expiresAt: issued.expiresAt,
      };
    },
    registerPasskey: async (_, { challenge, response, name }, ctx) => {
      const auth = await authOf(ctx);
      const current = await currentOf(auth, ctx.request);
      return passkeyOut(
        await auth.passkeys.register(current, {
          challenge,
          response: responseOf(response),
          name,
        }),
      );
    },
    removePasskey: async (_, { id }, ctx) => {
      const auth = await authOf(ctx);
      return auth.passkeys.remove(await currentOf(auth, ctx.request), id);
    },
  },
};
