import type { StepUpByEmail } from "@softistx/janus";
import {
  denial,
  passkeyResolvers,
  type SecondFactorResolvers,
  secondFactorResolvers,
} from "@softistx/janus-graphql";
import type { Context } from "@/http/context";
import type { AuthMethod } from "@/modules/audit";
import { recordingSignIn } from "@/modules/auth";
import { revokeIfSso } from "@/modules/connections";
import { asPasskeyInvalid, currentOf, responseOf } from "@/modules/passkeys";
import { requireMethod } from "@/modules/sign-in-methods";
import { requireLive } from "@/tenancy/live";
import { secondFactorDisabled } from "./mfa.errors";
import { recordStepUp } from "./mfa.events";
import type {
  MfaPorts,
  SecondFactorDone,
  SecondFactorMethod,
} from "./mfa.types";
import {
  confirmed,
  FRESH_WITHIN,
  iso,
  nameOf,
  signedInUserOf,
} from "./mfa.utils";

/**
 * The TOTP second factor of the signed-in user, the passkey second factor and
 * the step-up, the one service of the domain. The factor's own operations are
 * janus-graphql's (`secondFactorResolvers`, which asks `auth` on every field
 * for the instance of the tenant that serves the request); this service
 * records the sign-ins and the step-ups and shapes the answers.
 */
export class MfaService {
  private readonly janus: SecondFactorResolvers = secondFactorResolvers({
    auth: (ctx) => this.authOf(ctx as Context),
    freshWithin: FRESH_WITHIN,
    sendStepUpCode: (issued, ctx) =>
      this.sendStepUpCode(issued, ctx as Context),
    guard: async (action, _user, ctx) => {
      if (action !== "enroll" && action !== "activate") return;
      const tenant = await (ctx as Context).tenant();
      if (tenant === null || !tenant.signIn.mfa.totp) {
        throw secondFactorDisabled();
      }
    },
  });

  // The assertion check and the challenge's five attempts are janus's
  // (`confirmSecondFactorPasskey`); this service records and shapes the answer.
  private readonly janusPasskey = passkeyResolvers({
    auth: (ctx: Context) => this.authOf(ctx),
    firstFactor: true, // the instance's type; only `confirmSecondFactorPasskey` is used
  });

  constructor(private readonly ports: MfaPorts) {}

  private async authOf(ctx: Context) {
    const auth = await this.ports.issuers.forRequest(ctx.request);
    if (auth === null) throw denial("NOT_FOUND", "No such tenant");
    return auth;
  }

  /** The tenant of the request's host, or NOT_FOUND. */
  private async tenantOf(ctx: Context) {
    const tenant = await ctx.tenant();
    if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
    return tenant;
  }

  /** The e-mailed code of a step-up (a user with no second factor), sent from the tenant's own sender. */
  private async sendStepUpCode(issued: StepUpByEmail<object>, ctx: Context) {
    const tenant = await this.tenantOf(ctx);
    await this.ports.mailOf(tenant).stepUp(issued, {
      name: nameOf(issued.user) ?? issued.email,
    });
  }

  /** The signed-in user's second factor. */
  secondFactor(ctx: Context) {
    return this.janus.Query.secondFactor(undefined, undefined, ctx);
  }

  /** Until when the session counts as freshly confirmed; `null` when it never was. */
  async sessionConfirmedUntil(ctx: Context) {
    const until = await this.janus.Query.sessionConfirmedUntil(
      undefined,
      undefined,
      ctx,
    );
    return until === null ? null : iso(until);
  }

  /** A second-factor sign-in: recorded like any sign-in (method `totp` or `recoveryCode`), the session cookie janus's. */
  private async answer(
    ctx: Context,
    method: SecondFactorMethod,
    run: () => Promise<SecondFactorDone>,
  ) {
    const tenant = await this.tenantOf(ctx);
    requireLive(tenant);
    const auth = await this.ports.issuers.forRequest(ctx.request);
    const since = this.ports.now();
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
    await this.ports.usage.recordActive(tenant.tenantId, done.userId);
    const user = auth === null ? null : await auth.findUser(done.userId);
    if (user === null) {
      throw denial("FORBIDDEN", "Sign-in could not be completed");
    }
    return {
      user: signedInUserOf(user),
      expiresAt: iso(done.expiresAt),
      newDevice: done.newDevice,
      recoveryCodesLeft: done.recoveryCodesLeft ?? null,
    };
  }

  /** Finishes a sign-in that stopped at a challenge with a TOTP code. */
  confirmSecondFactor(ctx: Context, challenge: string, code: string) {
    return this.answer(ctx, "totp", () =>
      this.janus.Mutation.confirmSecondFactor(
        undefined,
        { challenge, code },
        ctx,
      ),
    );
  }

  /** Finishes a sign-in that stopped at a challenge with a recovery code. */
  recoverSecondFactor(ctx: Context, challenge: string, recoveryCode: string) {
    return this.answer(ctx, "recoveryCode", () =>
      this.janus.Mutation.recoverSecondFactor(
        undefined,
        { challenge, recoveryCode },
        ctx,
      ),
    );
  }

  /** Finishes a sign-in that stopped at a challenge with a passkey assertion. */
  async confirmSecondFactorWithPasskey(
    ctx: Context,
    challenge: string,
    assertion: string,
  ) {
    // A challenge outlives a policy change: a tenant that turned passkeys off no longer opens sessions with one.
    const tenant = await this.tenantOf(ctx);
    requireMethod(tenant, "passkey");
    return this.answer(ctx, "passkey", () =>
      this.janusPasskey.Mutation.confirmSecondFactorPasskey(
        undefined,
        { challenge, assertion },
        ctx,
      ),
    );
  }

  /**
   * The passkey options of a second-factor challenge, read again. Read-only:
   * no attempt counted, nothing spent. The tenant first, so a host that names
   * none is NOT_FOUND before any throttle budget is spent.
   */
  async passkeyOptions(ctx: Context, challenge: string) {
    const tenant = await this.tenantOf(ctx);
    requireLive(tenant);
    requireMethod(tenant, "passkey");
    await ctx.passkeyThrottle.check({ tenantId: tenant.tenantId, ip: ctx.ip });
    const auth = await this.authOf(ctx);
    const options = await auth.secondFactor.passkeyOptions(challenge);
    ctx.set.headers.set("cache-control", "no-store");
    return { options: JSON.stringify(options) };
  }

  /** Starts a factor: its secret and `otpauth://` URI, never cached. */
  async enrollSecondFactor(ctx: Context) {
    const out = await this.janus.Mutation.enrollSecondFactor(
      undefined,
      undefined,
      ctx,
    );
    ctx.set.headers.set("cache-control", "no-store");
    return out;
  }

  /** Activates the factor with its first code; the recovery codes are shown once. */
  async activateSecondFactor(ctx: Context, code: string) {
    const out = await this.janus.Mutation.activateSecondFactor(
      undefined,
      { code },
      ctx,
    );
    ctx.set.headers.set("cache-control", "no-store");
    return { recoveryCodes: [...out.recoveryCodes] };
  }

  /** Issues a new set of recovery codes. */
  async regenerateRecoveryCodes(ctx: Context, code: string) {
    const out = await this.janus.Mutation.regenerateRecoveryCodes(
      undefined,
      { code },
      ctx,
    );
    ctx.set.headers.set("cache-control", "no-store");
    return { recoveryCodes: [...out.recoveryCodes] };
  }

  /** Turns the signed-in user's factor off. */
  disableSecondFactor(ctx: Context, code: string) {
    return this.janus.Mutation.disableSecondFactor(undefined, { code }, ctx);
  }

  /**
   * D10: a step-up renews the proof and, by an app code or a passkey, reaches
   * `mfa`. The e-mailed code (a user with no factor) only renews it.
   */
  async requestStepUp(ctx: Context) {
    const out = await this.janus.Mutation.requestStepUp(
      undefined,
      undefined,
      ctx,
    );
    ctx.set.headers.set("cache-control", "no-store");
    return {
      via:
        out.via === "email" ? ("EMAIL" as const) : ("SECOND_FACTOR" as const),
      challenge: out.challenge,
      expiresAt: iso(out.expiresAt),
    };
  }

  /** Runs one confirmation of the signed-in user and records it, the refusal rethrown unchanged. */
  private async recordingStepUp<T>(
    ctx: Context,
    method: AuthMethod,
    run: () => Promise<T>,
  ): Promise<T> {
    const user = await ctx.janus.user();
    if (user === null) throw denial("UNAUTHENTICATED");
    try {
      const done = await run();
      await recordStepUp(ctx, method, user.id);
      return done;
    } catch (error) {
      await recordStepUp(ctx, method, user.id, error);
      throw error;
    }
  }

  /** Confirms a step-up by the e-mailed code or the app code; recorded under the method used. */
  async confirmStepUp(ctx: Context, challenge: string, code: string) {
    const user = await ctx.janus.user();
    const auth = await this.ports.issuers.forRequest(ctx.request);
    const totp =
      user !== null &&
      auth !== null &&
      (await auth.secondFactor.recoveryCodesLeft(user)) !== null;
    const out = await this.recordingStepUp(
      ctx,
      totp ? "totp" : "emailCode",
      () =>
        this.janus.Mutation.confirmStepUp(undefined, { challenge, code }, ctx),
    );
    return {
      confirmedAt: iso(out.confirmedAt),
      confirmedUntil:
        out.confirmedUntil === null ? null : iso(out.confirmedUntil),
    };
  }

  /** `requestPasskeyStepUp`: the options for the user's own passkeys. */
  async requestPasskeyStepUp(ctx: Context) {
    const tenant = await ctx.tenant();
    const auth = await this.ports.issuers.forRequest(ctx.request);
    if (auth === null || tenant === null) {
      throw denial("NOT_FOUND", "No such tenant");
    }
    requireLive(tenant);
    const { user } = await currentOf(auth, ctx.request);
    const issued = await auth.stepUp.request(user, { via: "passkey" });
    ctx.set.headers.set("cache-control", "no-store");
    return {
      options: JSON.stringify(issued.options),
      challenge: issued.challenge,
      expiresAt: issued.expiresAt,
    };
  }

  /** `confirmPasskeyStepUp`: the session of the request is stamped `hwk`, `user`, `mfa`. */
  async confirmPasskeyStepUp(
    ctx: Context,
    challenge: string,
    response: string,
  ) {
    const auth = await this.authOf(ctx);
    await currentOf(auth, ctx.request);
    const session = await this.recordingStepUp(ctx, "passkey", () =>
      asPasskeyInvalid(() =>
        auth.stepUp.confirmPasskey(
          ctx.request,
          challenge,
          responseOf(response),
        ),
      ),
    );
    return confirmed(session.authenticatedAt);
  }
}
