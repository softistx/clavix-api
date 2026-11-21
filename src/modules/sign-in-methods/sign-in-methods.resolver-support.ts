import { denial, socialResolvers } from "@softistx/janus-graphql";
import { grantsRevokeQueue } from "@/config/grants-revoke";
import { secretBox } from "@/config/keys";
import { usageService } from "@/config/usage";
import { janusIssuers } from "@/config/users";
import type { Context } from "@/http/context";
import { challengeAnswer } from "@/modules/mfa";
import { services } from "@/modules/services";
import {
  bindSsoCallback,
  connectionIdOfCallbackUrl,
  socialOf,
} from "@/modules/users";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { methodDisabled } from "./sign-in-methods.errors";
import {
  type MethodType,
  methodsOf,
  offeredSocial,
  SOCIAL_LABELS,
} from "./sign-in-methods.schema";

/** Set by the BFF from the path of its callback route (`/sign-in/social/:provider/callback`), never from the browser's own claim. */
const SSO_CONNECTION_HEADER = "x-sso-connection";

const HOSTED = {
  passkey: "PASSKEY",
  emailCode: "EMAIL_CODE",
  magicLink: "MAGIC_LINK",
  password: "PASSWORD",
} as const satisfies Record<MethodType, string>;

/** The tenant the request's host names, or NOT_FOUND. */
export async function tenantOf(ctx: Context) {
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

/** The request's janus instance, resolved once per request. */
export const authOf = (request: Request) => {
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
  // Each connection has its own callback URL (nxgt-janus#975/#987): the
  // callback is bound to the connection whose URL received it, so an identity
  // provider cannot pass a visitor's flow on to another one (RFC 9207 mix-up).
  bindCallback: async (callback, { args, ctx }) => {
    const auth = ctx.request === undefined ? null : await authOf(ctx.request);
    if (auth === null) return callback;
    // The id comes from the path of the callback URL the identity provider
    // redirected the visitor to, and the BFF states the id of the route that
    // received it (`x-sso-connection`): both must agree. A missing or
    // disagreeing one binds to nothing, which a connection's flow refuses
    // (an unbound callback fails closed). A static app's callback is bound to its
    // own name too, which its provider ignores.
    const named = connectionIdOfCallbackUrl(args.callbackUrl);
    const stated = ctx.request?.headers.get(SSO_CONNECTION_HEADER) ?? null;
    if (named === null || named !== stated) return callback;
    return bindSsoCallback(auth, named, callback);
  },
});

/**
 * The tenant's social instance; `SIGN_IN_METHOD_DISABLED` for a tenant with no
 * social provider. The instance also carries the tenant's enterprise
 * connections (every tenant has the resolver): the surface is open when the
 * tenant offers a static social app or has a connection, and refused as before
 * otherwise.
 */
export async function socialOfTenant(ctx: Context) {
  const auth = await authOf(ctx.request);
  if (auth === null) throw denial("NOT_FOUND", "No such tenant");
  const instance = socialOf(auth);
  if (instance === null) throw methodDisabled("social");
  const { signIn, tenantId } = await tenantOf(ctx);
  if (
    offeredSocial(signIn, secretBox.opens).length === 0 &&
    (await services().connections.count(tenantId)) === 0
  ) {
    throw methodDisabled("social");
  }
  return { auth: instance, resolvers: social };
}

/** What the hosted sign-in page shows: the enabled methods, the static apps first, then the enterprise connections the tenant chose to show as a button (enabled, `showButton`), oldest first. */
export async function hostedMethods({ signIn, tenantId }: ResolvedTenant) {
  const { connections } = services();
  const list = await connections.list(tenantId);
  return {
    methods: methodsOf(signIn)
      .filter((method) => method.enabled)
      .map((method) => HOSTED[method.type]),
    social: [
      ...offeredSocial(signIn, secretBox.opens).map(({ provider }) => ({
        id: provider,
        label: SOCIAL_LABELS[provider],
      })),
      ...list
        .filter(
          (doc) =>
            doc.enabled &&
            doc.showButton &&
            connections.isOffered(tenantId, doc),
        )
        .map((doc) => ({ id: doc.connectionId, label: doc.name })),
    ],
  };
}

/**
 * Refuses a provider the tenant does not offer: not one of its static apps,
 * nor an enabled enterprise connection of the tenant (its id is the provider
 * name). A fixed word: the caller's string is not echoed.
 */
export async function requireOfferedProvider(
  tenant: ResolvedTenant,
  provider: string,
): Promise<void> {
  const offered = offeredSocial(tenant.signIn, secretBox.opens);
  if (offered.some((entry) => entry.provider === provider)) return;
  const { connections } = services();
  const connection = await connections.find(tenant.tenantId, provider);
  if (
    connection === undefined ||
    !connections.isOffered(tenant.tenantId, connection)
  ) {
    throw methodDisabled("this provider");
  }
}

/** What a completed social flow answers with. */
type Completed = Awaited<
  ReturnType<(typeof social)["Mutation"]["socialSignInComplete"]>
>;

/**
 * The answer of a completed social flow: the second-factor challenge, or the
 * signed-in user after what a replacement leaves is revoked. Nothing here
 * starts a link flow: a completed flow is a sign-in.
 */
export async function completedAnswer(
  ctx: Context,
  tenantId: string,
  auth: Awaited<ReturnType<typeof socialOfTenant>>["auth"],
  done: Completed,
) {
  if (done.status === "secondFactor") {
    return challengeAnswer(done, done.returnTo);
  }
  if (done.status !== "signedIn") {
    throw denial("FORBIDDEN", "Sign-in could not be completed");
  }
  // The address was taken from an unverified holder: janus dropped their
  // sessions, not the OAuth grants and refresh tokens (clavix-api #346).
  // First, so a missing profile cannot skip it: janus does not repeat
  // `replaced`, a retried sign-in would not revoke. A failed revocation is
  // queued and retried (clavix-api #353); unqueued, the sign-in fails.
  if (done.replaced) {
    await services().consent.revokeOnReplace(
      ctx,
      tenantId,
      done.userId,
      grantsRevokeQueue.current,
    );
  }
  // janus types the user as an id and a type only: read the profile.
  const user = await auth.findUser(done.userId);
  if (user === null) {
    throw denial("FORBIDDEN", "Sign-in could not be completed");
  }
  await usageService.recordActive(tenantId, user.id);
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
    replaced: done.replaced,
    returnTo: done.returnTo,
  };
}
