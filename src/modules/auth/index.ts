import { denial } from "@softistx/janus-graphql";
import { tenantMail } from "@/config/mail";
import { usageService } from "@/config/usage";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";
import {
  requireNoSso,
  requireNoSsoForUser,
  revokeIfSso,
} from "@/modules/connections/sso-gate";
import { challengeOf } from "@/modules/mfa/challenge";
import { requireMethod } from "@/modules/sign-in-methods/gate";
import { requireLive } from "@/tenancy/live";
import type { TenantJanus } from "@/users/tenant-janus";
import { deviceOptions } from "./device";
import {
  confirmEmailVerification,
  requestEmailVerification,
} from "./email-verification";
import {
  confirmMagicLink,
  magicLinkDisabled,
  requestMagicLink,
} from "./magic-link";
import { requestSignInCode, verifySignInCode } from "./sign-in";
import { recordingSignIn, recordSignOut } from "./sign-in-events";

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

/**
 * The answer of a sign-in step that may stop at a second factor: a session
 * (cookie set, activity counted) or the challenge of a user who holds a TOTP
 * factor, with no session yet. The challenge is single-use: `no-store`.
 */
async function answerSignIn(
  ctx: Context,
  auth: TenantJanus,
  tenantId: string,
  done: Awaited<ReturnType<typeof verifySignInCode>>,
) {
  ctx.set.headers.set("cache-control", "no-store");
  if (done.status === "secondFactor") {
    return challengeOf(done, ctx.request);
  }
  await usageService.recordActive(tenantId, done.user.id);
  ctx.set.headers.append(
    "set-cookie",
    auth.cookie.serialize(done.token, done.session),
  );
  return {
    __typename: "SignedIn" as const,
    user: currentUserOf(done.user),
    expiresAt: done.session.expiresAt,
  };
}

/**
 * D3: a user whose domain requires single sign-on gets no challenge and no
 * session from a code or a link, whatever the address typed. Run inside the
 * recorded attempt, so the refusal is a failed sign-in in the log.
 */
async function unlessSso(
  auth: TenantJanus,
  tenantId: string,
  done: Awaited<ReturnType<typeof verifySignInCode>>,
) {
  if (done.status === "secondFactor") {
    await requireNoSsoForUser(auth, tenantId, done.userId);
  } else {
    await revokeIfSso(auth, tenantId, done.user.id, { id: done.session.id });
  }
  return done;
}

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
      await requireNoSso(tenant.tenantId, email);
      return requestSignInCode(
        { auth, mail: tenantMail(tenant), signUp: tenant.signUp },
        email,
      );
    },
    verifySignInCode: async (_, { challenge, code }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      requireMethod(tenant, "emailCode");
      const done = await recordingSignIn(
        ctx,
        tenant.tenantId,
        "emailCode",
        async () =>
          unlessSso(
            auth,
            tenant.tenantId,
            await verifySignInCode(
              auth,
              challenge,
              code,
              deviceOptions(ctx.request),
            ),
          ),
        (result) => (result.status === "signedIn" ? result.user.id : null),
      );
      return answerSignIn(ctx, auth, tenant.tenantId, done);
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
      await requireNoSso(tenant.tenantId, email);
      return requestMagicLink(
        { auth, mail: tenantMail(tenant), signUp: tenant.signUp },
        email,
      );
    },
    confirmMagicLink: async (_, { token }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      if (!auth.magicLink.enabled) throw magicLinkDisabled();
      const done = await recordingSignIn(
        ctx,
        tenant.tenantId,
        "magicLink",
        async () =>
          unlessSso(
            auth,
            tenant.tenantId,
            await confirmMagicLink(auth, token, deviceOptions(ctx.request)),
          ),
        (result) => (result.status === "signedIn" ? result.user.id : null),
      );
      return answerSignIn(ctx, auth, tenant.tenantId, done);
    },
    requestEmailVerification: async (_, __, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      const current = await auth.authenticate(ctx.request);
      if (current === null) throw denial("UNAUTHENTICATED");
      ctx.set.headers.set("cache-control", "no-store");
      await ctx.verifyThrottle?.check({
        tenantId: tenant.tenantId,
        userId: current.user.id,
        ip: ctx.ip,
      });
      return requestEmailVerification(
        { auth, mail: tenantMail(tenant) },
        current.user,
      );
    },
    confirmEmailVerification: async (_, { token }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      const current = await auth.authenticate(ctx.request);
      if (current === null) throw denial("UNAUTHENTICATED");
      ctx.set.headers.set("cache-control", "no-store");
      return currentUserOf(
        await confirmEmailVerification(auth, token, current.user.id),
      );
    },
    signOut: async (_, __, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      const current = await auth.authenticate(ctx.request);
      await auth.signOut(ctx.request);
      if (current !== null) {
        await recordSignOut(ctx, tenant.tenantId, current.user.id);
      }
      ctx.set.headers.append("set-cookie", auth.cookie.clear());
      return true;
    },
  },
};
