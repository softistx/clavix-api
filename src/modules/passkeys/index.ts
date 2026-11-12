import { denial } from "@softistx/janus-graphql";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";
import { passkeysOn } from "@/users/rp";
import {
  currentOf,
  passkeyOut,
  responseOf,
  signInWithPasskey,
} from "./passkeys";

// janus-graphql ships a passkey SDL and `passkeyResolvers`, but they bind to
// one janus instance and know no first-factor sign-in: ours is per tenant, so
// the operations are written here on `auth.passkeys` (docs/guide/passkeys.md
// of @softistx/janus).
async function authOf(ctx: Context) {
  const [auth, tenant] = await Promise.all([
    janusIssuers.forRequest(ctx.request),
    ctx.tenant(),
  ]);
  if (auth === null || tenant === null) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  // Over http (development) janus has no passkeys configured.
  if (!passkeysOn(tenant)) throw denial("NOT_FOUND", "Passkeys need https");
  return auth;
}

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
      const auth = await authOf(ctx);
      const issued = await auth.passkeys.signInOptions();
      ctx.set.headers.set("cache-control", "no-store");
      return {
        options: JSON.stringify(issued.options),
        challenge: issued.challenge,
        expiresAt: issued.expiresAt,
      };
    },
    signInWithPasskey: async (_, { challenge, response }, ctx) => {
      const auth = await authOf(ctx);
      const signedIn = await signInWithPasskey(auth, challenge, response);
      ctx.set.headers.set("cache-control", "no-store");
      ctx.set.headers.append(
        "set-cookie",
        auth.cookie.serialize(signedIn.token, signedIn.session),
      );
      return {
        user: {
          id: signedIn.user.id,
          email: signedIn.user.email,
          name: signedIn.user.name ?? null,
          emailVerified: signedIn.user.emailVerified,
        },
        expiresAt: signedIn.session.expiresAt,
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
