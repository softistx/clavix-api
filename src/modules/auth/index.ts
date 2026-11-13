import { denial } from "@softistx/janus-graphql";
import { tenantMail } from "@/config/mail";
import { usageService } from "@/config/usage";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";
import { requireMethod } from "@/modules/sign-in-methods/gate";
import { requireLive } from "@/tenancy/live";
import {
  confirmMagicLink,
  magicLinkDisabled,
  requestMagicLink,
} from "./magic-link";
import { requestSignInCode, verifySignInCode } from "./sign-in";

// The janus instance and the tenant of the request's host; both are `null`
// for a host that names no active tenant.
async function tenantOf(ctx: Context) {
  const [auth, tenant] = await Promise.all([
    janusIssuers.forRequest(ctx.request),
    ctx.tenant(),
  ]);
  if (auth === null || tenant === null) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  return { auth, tenant };
}

const currentUserOf = (user: {
  id: string;
  email: string;
  name?: string | undefined;
  emailVerified: boolean;
}) => ({
  id: user.id,
  email: user.email,
  name: user.name ?? null,
  emailVerified: user.emailVerified,
});

export const auth: Resolvers = {
  Query: {
    currentUser: async (_, __, ctx) => {
      const user = await ctx.janus.user();
      return user === null ? null : currentUserOf(user);
    },
  },
  Mutation: {
    requestSignInCode: async (_, { email }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      requireMethod(tenant, "emailCode");
      ctx.set.headers.set("cache-control", "no-store");
      await ctx.signInThrottle?.check({
        tenantId: tenant.tenantId,
        ip: ctx.ip,
      });
      return requestSignInCode(
        { auth, mail: tenantMail(tenant), signUp: tenant.signUp },
        email,
      );
    },
    verifySignInCode: async (_, { challenge, code }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      requireMethod(tenant, "emailCode");
      const signedIn = await verifySignInCode(auth, challenge, code);
      await usageService.recordActive(tenant.tenantId, signedIn.user.id);
      ctx.set.headers.set("cache-control", "no-store");
      ctx.set.headers.append(
        "set-cookie",
        auth.cookie.serialize(signedIn.token, signedIn.session),
      );
      return {
        user: currentUserOf(signedIn.user),
        expiresAt: signedIn.session.expiresAt,
      };
    },
    requestMagicLink: async (_, { email }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      // Off: before any budget, store or mail is touched.
      if (!auth.magicLink.enabled) throw magicLinkDisabled();
      ctx.set.headers.set("cache-control", "no-store");
      await ctx.signInThrottle?.check({
        tenantId: tenant.tenantId,
        ip: ctx.ip,
      });
      return requestMagicLink(
        { auth, mail: tenantMail(tenant), signUp: tenant.signUp },
        email,
      );
    },
    confirmMagicLink: async (_, { token }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      if (!auth.magicLink.enabled) throw magicLinkDisabled();
      const signedIn = await confirmMagicLink(auth, token);
      await usageService.recordActive(tenant.tenantId, signedIn.user.id);
      ctx.set.headers.set("cache-control", "no-store");
      ctx.set.headers.append(
        "set-cookie",
        auth.cookie.serialize(signedIn.token, signedIn.session),
      );
      return {
        user: currentUserOf(signedIn.user),
        expiresAt: signedIn.session.expiresAt,
      };
    },
    signOut: async (_, __, ctx) => {
      const { auth } = await tenantOf(ctx);
      await auth.signOut(ctx.request);
      ctx.set.headers.append("set-cookie", auth.cookie.clear());
      return true;
    },
  },
};
