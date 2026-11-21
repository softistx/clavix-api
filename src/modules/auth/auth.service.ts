import { JanusError, MailThrottledError } from "@softistx/janus";
import type { Context } from "@/http/context";
import {
  requireNoSso,
  requireNoSsoForUser,
  revokeIfSso,
} from "@/modules/connections";
import { challengeOf } from "@/modules/mfa/mfa.challenge";
import { requireMethod } from "@/modules/sign-in-methods";
import type { TenantJanus } from "@/modules/users";
import { fail } from "@/shared/errors";
import { requireLive } from "@/tenancy/live";
import {
  codeInvalid,
  emailVerificationInvalid,
  emailVerificationThrottled,
  magicLinkDisabled,
  magicLinkInvalid,
} from "./auth.errors";
import { recordingSignIn, recordSignOut } from "./auth.events";
import { afterAnswer } from "./auth.outbox";
import type { AuthPorts, SignInDone } from "./auth.types";
import {
  currentUserOf,
  deviceOptions,
  MAGIC_LINK_LIFESPAN_MS,
  SIGN_IN_CODE_LIFESPAN_MS,
} from "./auth.utils";

/**
 * The hosted sign-in of a tenant: the e-mail code, the magic link, the e-mail
 * verification and the sign-out, the one service of the domain. Every method
 * runs for the tenant the request's host names, on its own janus instance. The
 * mails go out after the answer (`afterAnswer`), so the time a request takes
 * does not tell whether an address has an account.
 */
export class AuthService {
  constructor(private readonly ports: AuthPorts) {}

  /** The janus instance and the tenant of the request's host; a host that names no active tenant is a NOT_FOUND. */
  private async tenantOf(ctx: Context) {
    const [auth, tenant] = await Promise.all([
      this.ports.issuers.forRequest(ctx.request),
      ctx.tenant(),
    ]);
    if (auth === null || tenant === null) {
      throw fail("NOT_FOUND", "No such tenant", { status: 404 });
    }
    return { auth, tenant };
  }

  /** The signed-in user of the request, or UNAUTHENTICATED (401). */
  private async signedIn(auth: TenantJanus, request: Request) {
    const current = await auth.authenticate(request);
    if (current === null)
      throw fail("UNAUTHENTICATED", "Not signed in", { status: 401 });
    return current;
  }

  /** The signed-in user of the request, `null` when anonymous. */
  async currentUser(ctx: Context) {
    const user = await ctx.janus.user();
    return user === null ? null : currentUserOf(user);
  }

  /** Opens the account of an address on a tenant that allows sign-up; one that exists is left alone. */
  private async createIfOpen(auth: TenantJanus, email: string) {
    try {
      await auth.create({ email });
    } catch (error) {
      if (!(error instanceof JanusError && error.code === "LOGIN_TAKEN")) {
        throw error;
      }
    }
  }

  /**
   * The answer of a sign-in step that may stop at a second factor: a session
   * (cookie set, activity counted) or the challenge of a user who holds a TOTP
   * factor, with no session yet. The challenge is single-use: `no-store`.
   */
  private async answerSignIn(
    ctx: Context,
    auth: TenantJanus,
    tenantId: string,
    done: SignInDone,
  ) {
    ctx.set.headers.set("cache-control", "no-store");
    if (done.status === "secondFactor") {
      return challengeOf(done, ctx.request);
    }
    await this.ports.usage.recordActive(tenantId, done.user.id);
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
  private async unlessSso(
    auth: TenantJanus,
    tenantId: string,
    done: SignInDone,
  ) {
    if (done.status === "secondFactor") {
      await requireNoSsoForUser(auth, tenantId, done.userId);
    } else {
      await revokeIfSso(auth, tenantId, done.user.id, { id: done.session.id });
    }
    return done;
  }

  /** Records the step as a sign-in of `method` (success with its user, refusal with its reason). */
  private recorded(
    ctx: Context,
    tenantId: string,
    method: "emailCode" | "magicLink",
    run: () => Promise<SignInDone>,
  ) {
    return recordingSignIn(ctx, tenantId, method, run, (result) =>
      result.status === "signedIn" ? result.user.id : null,
    );
  }

  /**
   * Counts the request (past the limit: MAIL_THROTTLED), mints the challenge
   * for whoever asked, then, after the answer, creates the account when
   * sign-up is open, looks the address up and mails the code. An unknown
   * address on a closed tenant writes nothing and sends nothing; the visitor
   * cannot tell.
   */
  async requestSignInCode(ctx: Context, email: string) {
    const { auth, tenant } = await this.tenantOf(ctx);
    requireLive(tenant);
    requireMethod(tenant, "emailCode");
    ctx.set.headers.set("cache-control", "no-store");
    await ctx.signInThrottle.check({ tenantId: tenant.tenantId, ip: ctx.ip });
    await requireNoSso(tenant.tenantId, email);
    const mail = this.ports.mailOf(tenant);
    const { signUp } = tenant;
    const pending = await auth.signInCode.prepare(email);
    afterAnswer(async () => {
      if (signUp) await this.createIfOpen(auth, email);
      const issued = await pending.send();
      if (issued !== null) await mail.signInCode(issued);
    }, this.ports.log);
    return {
      challenge: pending.challenge,
      expiresAt: new Date(
        this.ports.now().getTime() + SIGN_IN_CODE_LIFESPAN_MS,
      ),
    };
  }

  /** Confirms the e-mailed code: a session, or the second-factor challenge of a user who holds a factor. */
  async verifySignInCode(ctx: Context, challenge: string, code: string) {
    const { auth, tenant } = await this.tenantOf(ctx);
    requireLive(tenant);
    requireMethod(tenant, "emailCode");
    const done = await this.recorded(ctx, tenant.tenantId, "emailCode", () =>
      this.confirmCode(auth, tenant.tenantId, challenge, code, ctx.request),
    );
    return this.answerSignIn(ctx, auth, tenant.tenantId, done);
  }

  /** Every refusal of janus but a store failure is one `CODE_INVALID`. */
  private async confirmCode(
    auth: TenantJanus,
    tenantId: string,
    challenge: string,
    code: string,
    request: Request,
  ) {
    let done: SignInDone;
    try {
      done = await auth.signInCode.confirm(
        challenge,
        code,
        deviceOptions(request),
      );
    } catch (error) {
      if (error instanceof JanusError && error.code !== "STORE_FAILED") {
        throw codeInvalid();
      }
      throw error;
    }
    return this.unlessSso(auth, tenantId, done);
  }

  /**
   * Counts the request (past the limit: MAIL_THROTTLED), then, after the
   * answer, creates the account when sign-up is open, looks the address up and
   * mails the link. An unknown address on a closed tenant writes nothing and
   * sends nothing; the answer is the same either way. janus refuses to enrol a
   * second factor or a passkey while the e-mail is unproved (EMAIL_UNVERIFIED),
   * so a link that proves it first has nothing of a squatter's to wipe.
   */
  async requestMagicLink(ctx: Context, email: string) {
    const { auth, tenant } = await this.tenantOf(ctx);
    requireLive(tenant);
    // Off: before any budget, store or mail is touched.
    if (!auth.magicLink.enabled) throw magicLinkDisabled();
    ctx.set.headers.set("cache-control", "no-store");
    await ctx.signInThrottle.check({ tenantId: tenant.tenantId, ip: ctx.ip });
    await requireNoSso(tenant.tenantId, email);
    const mail = this.ports.mailOf(tenant);
    const { signUp } = tenant;
    const pending = await auth.magicLink.prepare(email);
    afterAnswer(async () => {
      if (signUp) await this.createIfOpen(auth, email);
      const issued = await pending.send();
      if (issued !== null) await mail.magicLink(issued);
    }, this.ports.log);
    return {
      expiresAt: new Date(this.ports.now().getTime() + MAGIC_LINK_LIFESPAN_MS),
    };
  }

  /** Confirms a magic link: a session, or the second-factor challenge of a user who holds a factor. */
  async confirmMagicLink(ctx: Context, token: string) {
    const { auth, tenant } = await this.tenantOf(ctx);
    requireLive(tenant);
    if (!auth.magicLink.enabled) throw magicLinkDisabled();
    const done = await this.recorded(ctx, tenant.tenantId, "magicLink", () =>
      this.confirmLink(auth, tenant.tenantId, token, ctx.request),
    );
    return this.answerSignIn(ctx, auth, tenant.tenantId, done);
  }

  /** Every refusal of janus but a store failure is one `MAGIC_LINK_INVALID`. */
  private async confirmLink(
    auth: TenantJanus,
    tenantId: string,
    token: string,
    request: Request,
  ) {
    let done: SignInDone;
    try {
      done = await auth.magicLink.confirm(token, deviceOptions(request));
    } catch (error) {
      if (error instanceof JanusError) {
        if (error.code === "MAGIC_LINK_DISABLED") throw magicLinkDisabled();
        if (error.code !== "STORE_FAILED") throw magicLinkInvalid();
      }
      throw error;
    }
    return this.unlessSso(auth, tenantId, done);
  }

  /**
   * Mails the signed-in user a verification link. Always `true`: janus counts
   * the address (past five in 10 minutes: `EMAIL_VERIFICATION_THROTTLED`, the
   * same code as our own limits), and, after the answer, `send()` issues a
   * token for the active, unverified holder of the address only, so an already
   * verified user gets the same answer and no mail. The link goes to the
   * signed-in account's own address, never to another account that has since
   * come to hold it.
   */
  async requestEmailVerification(ctx: Context): Promise<true> {
    const { auth, tenant } = await this.tenantOf(ctx);
    requireLive(tenant);
    const { user } = await this.signedIn(auth, ctx.request);
    ctx.set.headers.set("cache-control", "no-store");
    await ctx.verifyThrottle.check({
      tenantId: tenant.tenantId,
      userId: user.id,
      ip: ctx.ip,
    });
    const mail = this.ports.mailOf(tenant);
    try {
      // `prepare(email)` then the id check, not `send(user)`: `send(user)`
      // issues for the current address whatever its state, so a verified user
      // would be mailed.
      const pending = await auth.verifyEmail.prepare(user.email);
      afterAnswer(async () => {
        const issued = await pending.send();
        if (issued !== null && issued.user.id === user.id) {
          await mail.verifyEmail(issued, {
            name: issued.user.name ?? issued.email,
          });
        }
      }, this.ports.log);
    } catch (error) {
      if (error instanceof MailThrottledError) {
        throw emailVerificationThrottled(error.retryAfter ?? 600);
      }
      throw error;
    }
    return true;
  }

  /**
   * Proves the address from the token, for the signed-in account only
   * (`{ user }`): another account's token is refused and left unspent. No
   * first proof: the password and second factor stay. Unknown, spent, expired
   * and stale tokens are one `EMAIL_VERIFICATION_INVALID`; a store outage
   * stays 503.
   */
  async confirmEmailVerification(ctx: Context, token: string) {
    const { auth, tenant } = await this.tenantOf(ctx);
    requireLive(tenant);
    const { user } = await this.signedIn(auth, ctx.request);
    ctx.set.headers.set("cache-control", "no-store");
    try {
      return currentUserOf(
        await auth.verifyEmail.confirm(token, { user: user.id }),
      );
    } catch (error) {
      if (error instanceof JanusError && error.code !== "STORE_FAILED") {
        throw emailVerificationInvalid();
      }
      throw error;
    }
  }

  /** Ends the session of the request, records it and clears the cookie. */
  async signOut(ctx: Context) {
    const { auth, tenant } = await this.tenantOf(ctx);
    const current = await auth.authenticate(ctx.request);
    await auth.signOut(ctx.request);
    if (current !== null) {
      await recordSignOut(ctx, tenant.tenantId, current.user.id);
    }
    ctx.set.headers.append("set-cookie", auth.cookie.clear());
    return true;
  }
}
