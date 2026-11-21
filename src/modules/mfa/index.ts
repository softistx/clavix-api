import {
  denial,
  passkeyResolvers,
  type SecondFactorResolvers,
  secondFactorResolvers,
} from "@softistx/janus-graphql";
import { usageService } from "@/config/usage";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";
import { recordingSignIn } from "@/modules/auth/sign-in-events";
import { revokeIfSso } from "@/modules/connections";
import { requireMethod } from "@/modules/sign-in-methods";
import { fail } from "@/shared/errors";
import { requireLive } from "@/tenancy/live";
import {
  confirmPasskeyStepUp,
  recordingStepUp,
  requestPasskeyStepUp,
  sendStepUpCode,
} from "./step-up";

/** How long a session counts as freshly confirmed for the writes of the factor. */
const FRESH_WITHIN = "10m" as const;

/** TOTP is off for the tenant: nobody starts a factor (one that exists is kept). */
export const secondFactorDisabled = () =>
  fail(
    "SECOND_FACTOR_DISABLED",
    "Two-factor authentication is not offered by this tenant",
    { status: 403 },
  );

// `auth` is a function of the context: janus-graphql asks it on every field for
// the instance of the tenant that serves the request (nxgt-janus#914).
const janus: SecondFactorResolvers = secondFactorResolvers({
  auth: (ctx) => passkeyAuthOf(ctx as Context),
  freshWithin: FRESH_WITHIN,
  sendStepUpCode: (issued, ctx) => sendStepUpCode(issued, ctx as Context),
  guard: async (action, _user, ctx) => {
    if (action !== "enroll" && action !== "activate") return;
    const tenant = await (ctx as Context).tenant();
    if (tenant === null || !tenant.signIn.mfa.totp) {
      throw secondFactorDisabled();
    }
  },
});

// The assertion check and the challenge's five attempts are janus's
// (`confirmSecondFactorPasskey`); this module records and shapes the answer.
async function passkeyAuthOf(ctx: Context) {
  const auth = await janusIssuers.forRequest(ctx.request);
  if (auth === null) throw denial("NOT_FOUND", "No such tenant");
  return auth;
}
const janusPasskey = passkeyResolvers({
  auth: passkeyAuthOf,
  firstFactor: true, // the instance's type; only `confirmSecondFactorPasskey` is used
});

const iso = (value: string) => new Date(value);

export const mfa: Resolvers = {
  Query: {
    secondFactor: async (_, __, ctx) =>
      janus.Query.secondFactor(_, undefined, ctx),
    sessionConfirmedUntil: async (_, __, ctx) => {
      const until = await janus.Query.sessionConfirmedUntil(_, undefined, ctx);
      return until === null ? null : iso(until);
    },
  },
  Mutation: {
    confirmSecondFactor: async (_, { challenge, code }, ctx) => {
      return answer(ctx, "totp", () =>
        janus.Mutation.confirmSecondFactor(_, { challenge, code }, ctx),
      );
    },
    recoverSecondFactor: async (_, { challenge, recoveryCode }, ctx) => {
      return answer(ctx, "recoveryCode", () =>
        janus.Mutation.recoverSecondFactor(_, { challenge, recoveryCode }, ctx),
      );
    },
    confirmSecondFactorWithPasskey: async (
      _,
      { challenge, assertion },
      ctx,
    ) => {
      // A challenge outlives a policy change: a tenant that turned passkeys off no longer opens sessions with one.
      const tenant = await ctx.tenant();
      if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
      requireMethod(tenant, "passkey");
      return answer(ctx, "passkey", () =>
        janusPasskey.Mutation.confirmSecondFactorPasskey(
          _,
          { challenge, assertion },
          ctx,
        ),
      );
    },
    requestSecondFactorPasskeyOptions: async (_, { challenge }, ctx) => {
      // Read-only: no attempt counted, nothing spent. The tenant first, so a
      // host that names none is NOT_FOUND before any throttle budget is spent.
      const tenant = await ctx.tenant();
      if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
      requireLive(tenant);
      requireMethod(tenant, "passkey");
      await ctx.passkeyThrottle?.check({
        tenantId: tenant.tenantId,
        ip: ctx.ip,
      });
      const auth = await passkeyAuthOf(ctx);
      const options = await auth.secondFactor.passkeyOptions(challenge);
      ctx.set.headers.set("cache-control", "no-store");
      return { options: JSON.stringify(options) };
    },
    enrollSecondFactor: async (_, __, ctx) => {
      const out = await janus.Mutation.enrollSecondFactor(_, undefined, ctx);
      ctx.set.headers.set("cache-control", "no-store");
      return out;
    },
    activateSecondFactor: async (_, { code }, ctx) => {
      const out = await janus.Mutation.activateSecondFactor(_, { code }, ctx);
      ctx.set.headers.set("cache-control", "no-store");
      return { recoveryCodes: [...out.recoveryCodes] };
    },
    regenerateRecoveryCodes: async (_, { code }, ctx) => {
      const out = await janus.Mutation.regenerateRecoveryCodes(
        _,
        { code },
        ctx,
      );
      ctx.set.headers.set("cache-control", "no-store");
      return { recoveryCodes: [...out.recoveryCodes] };
    },
    disableSecondFactor: async (_, { code }, ctx) =>
      janus.Mutation.disableSecondFactor(_, { code }, ctx),
    // D10: a step-up renews the proof and, by an app code or a passkey, reaches
    // `mfa`. The e-mailed code (a user with no factor) only renews it.
    requestStepUp: async (_, __, ctx) => {
      const out = await janus.Mutation.requestStepUp(_, undefined, ctx);
      ctx.set.headers.set("cache-control", "no-store");
      return {
        via: out.via === "email" ? "EMAIL" : "SECOND_FACTOR",
        challenge: out.challenge,
        expiresAt: iso(out.expiresAt),
      };
    },
    confirmStepUp: async (_, { challenge, code }, ctx) => {
      const user = await ctx.janus.user();
      const auth = await janusIssuers.forRequest(ctx.request);
      const totp =
        user !== null &&
        auth !== null &&
        (await auth.secondFactor.recoveryCodesLeft(user)) !== null;
      const out = await recordingStepUp(ctx, totp ? "totp" : "emailCode", () =>
        janus.Mutation.confirmStepUp(_, { challenge, code }, ctx),
      );
      return {
        confirmedAt: iso(out.confirmedAt),
        confirmedUntil:
          out.confirmedUntil === null ? null : iso(out.confirmedUntil),
      };
    },
    requestPasskeyStepUp: async (_, __, ctx) => requestPasskeyStepUp(ctx),
    confirmPasskeyStepUp: async (_, { challenge, response }, ctx) =>
      confirmPasskeyStepUp(ctx, challenge, response),
  },
};

/** A second-factor sign-in: recorded like any sign-in (method `totp` or `recoveryCode`), the session cookie janus's. */
async function answer(
  ctx: Context,
  method: "totp" | "recoveryCode" | "passkey",
  run: () => Promise<{
    userId: string;
    expiresAt: string;
    newDevice: boolean;
    recoveryCodesLeft?: number | null;
  }>,
) {
  const tenant = await ctx.tenant();
  if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
  requireLive(tenant);
  const auth = await janusIssuers.forRequest(ctx.request);
  const since = new Date();
  const done = await recordingSignIn(
    ctx,
    tenant.tenantId,
    method,
    async () => {
      const result = await run();
      // D3: a challenge issued before `requireSso` turned on opens no session.
      if (auth !== null) {
        await revokeIfSso(auth, tenant.tenantId, result.userId, { since });
      }
      return result;
    },
    (result) => result.userId,
  );
  ctx.set.headers.set("cache-control", "no-store");
  await usageService.recordActive(tenant.tenantId, done.userId);
  const user = auth === null ? null : await auth.findUser(done.userId);
  if (user === null)
    throw denial("FORBIDDEN", "Sign-in could not be completed");
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      emailVerified: user.emailVerified,
    },
    expiresAt: iso(done.expiresAt),
    newDevice: done.newDevice,
    recoveryCodesLeft: done.recoveryCodesLeft ?? null,
  };
}
