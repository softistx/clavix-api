import { denial, passkeyResolvers } from "@softistx/janus-graphql";
import type { Context } from "@/http/context";
import { recordingSignIn } from "@/modules/auth";
import { requireNoSsoForUser } from "@/modules/connections";
import { requireMethod } from "@/modules/sign-in-methods";
import { requireLive } from "@/tenancy/live";
import { asPasskeyInvalid, passkeyInvalid } from "./passkeys.errors";
import type { PasskeysPorts } from "./passkeys.types";
import {
  ceremonyOut,
  currentOf,
  passkeyOut,
  responseOf,
} from "./passkeys.utils";

/**
 * The passkeys of a tenant's users, the one service of the domain: the
 * passkey sign-in (janus-graphql's `passkeyResolvers` with `firstFactor`, so
 * the challenge, the assertion check and the session cookie are janus's, under
 * this API's own names, arguments and errors) and the management of the
 * signed-in user's passkeys, written on `auth.passkeys`.
 */
export class PasskeysService {
  // D3: `signInGuard` runs once the assertion verified and before any session,
  // token or cookie exists: a user who must use single sign-on is refused with
  // nothing to revoke.
  private readonly janus = passkeyResolvers({
    auth: (ctx: Context) => this.authOf(ctx),
    firstFactor: true,
    signInGuard: async (user, ctx) => {
      const [auth, tenant] = await Promise.all([
        this.authOf(ctx),
        ctx.tenant(),
      ]);
      if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
      await requireNoSsoForUser(auth, tenant.tenantId, user.id);
    },
  });

  constructor(private readonly ports: PasskeysPorts) {}

  private async authOf(ctx: Context) {
    const [auth, tenant] = await Promise.all([
      this.ports.issuers.forRequest(ctx.request),
      ctx.tenant(),
    ]);
    if (auth === null || tenant === null) {
      throw denial("NOT_FOUND", "No such tenant");
    }
    return auth;
  }

  /** The live tenant of the request that offers passkeys, or the refusal. */
  private async passkeyTenant(ctx: Context) {
    const tenant = await ctx.tenant();
    if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
    requireLive(tenant);
    requireMethod(tenant, "passkey");
    return tenant;
  }

  /** The signed-in user's passkeys. */
  async list(ctx: Context) {
    const auth = await this.authOf(ctx);
    const { user } = await currentOf(auth, ctx.request);
    return (await auth.passkeys.list(user)).map(passkeyOut);
  }

  /**
   * The options of an anonymous passkey sign-in. The tenant first: a host that
   * names none is a NOT_FOUND before any throttle budget is spent. The key is
   * the client address and the tenant.
   */
  async signInOptions(ctx: Context) {
    const tenant = await this.passkeyTenant(ctx);
    await ctx.passkeyThrottle?.check({
      tenantId: tenant.tenantId,
      ip: ctx.ip,
    });
    return this.janus.Query.passkeySignInOptions(undefined, undefined, ctx);
  }

  /** Signs in with a passkey assertion: the session cookie is janus's, the attempt is recorded. */
  async signIn(ctx: Context, challenge: string, response: string) {
    const tenant = await this.passkeyTenant(ctx);
    const auth = await this.authOf(ctx);
    const signedIn = await recordingSignIn(
      ctx,
      tenant.tenantId,
      "passkey",
      // D3: the sign-in guard refuses a user who must use single sign-on
      // before any session or cookie exists; the attempt is a failure.
      async () =>
        asPasskeyInvalid(() =>
          this.janus.Mutation.passkeySignIn(
            undefined,
            { challenge, assertion: response },
            ctx,
          ),
        ),
      (done) => done.userId,
    );
    // janus types `signedIn.user` as an id and a type only: read the profile.
    const user = await auth.findUser(signedIn.userId);
    if (user === null) throw passkeyInvalid();
    await this.ports.usage.recordActive(tenant.tenantId, user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        emailVerified: user.emailVerified,
      },
      expiresAt: signedIn.expiresAt,
    };
  }

  /** The options to register a passkey for the signed-in user. */
  async registrationOptions(ctx: Context) {
    const auth = await this.authOf(ctx);
    const { user } = await currentOf(auth, ctx.request);
    const issued = await auth.passkeys.registrationOptions(user);
    ctx.set.headers.set("cache-control", "no-store");
    return ceremonyOut(issued);
  }

  /** Registers the passkey the browser created. */
  async register(
    ctx: Context,
    challenge: string,
    response: string,
    name: string,
  ) {
    const auth = await this.authOf(ctx);
    const current = await currentOf(auth, ctx.request);
    return passkeyOut(
      await auth.passkeys.register(current, {
        challenge,
        response: responseOf(response),
        name,
      }),
    );
  }

  /** Removes one of the signed-in user's passkeys. */
  async remove(ctx: Context, id: string) {
    const auth = await this.authOf(ctx);
    return auth.passkeys.remove(await currentOf(auth, ctx.request), id);
  }
}
