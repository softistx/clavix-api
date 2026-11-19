import type { StepUpByEmail } from "@softistx/janus";
import { denial } from "@softistx/janus-graphql";
import { eventBus } from "@/config/events";
import { tenantMail } from "@/config/mail";
import { janusIssuers } from "@/config/users";
import type { Context } from "@/http/context";
import type { AuthMethod } from "@/modules/audit/auth-events.model";
import { reasonOf, sourceOf } from "@/modules/auth/sign-in-events";
import {
  asPasskeyInvalid,
  currentOf,
  responseOf,
} from "@/modules/passkeys/passkeys";
import { requireLive } from "@/tenancy/live";

/** `FRESH_WITHIN` of `mfa/index.ts` in milliseconds: the window `confirmedUntil` answers. */
export const FRESH_WITHIN_MS = 10 * 60 * 1000;

const nameOf = (user: object): string | null => {
  const name = (user as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : null;
};

/** The e-mailed code of a step-up (a user with no second factor), sent from the tenant's own sender. */
export async function sendStepUpCode(
  issued: StepUpByEmail<object>,
  ctx: Context,
) {
  const tenant = await ctx.tenant();
  if (tenant === null) throw denial("NOT_FOUND", "No such tenant");
  await tenantMail(tenant).stepUp(issued, {
    name: nameOf(issued.user) ?? issued.email,
  });
}

const confirmed = (at: Date) => ({
  confirmedAt: at,
  confirmedUntil: new Date(at.getTime() + FRESH_WITHIN_MS),
});

/** The audit record of a step-up (D14), success or refusal. Never throws (D13). */
async function record(
  ctx: Context,
  method: AuthMethod,
  userId: string,
  failure?: unknown,
) {
  const tenant = await ctx.tenant();
  if (tenant === null) return;
  await eventBus.emit({
    kind: "auth",
    tenantId: tenant.tenantId,
    type: "stepUp.confirm",
    outcome: failure === undefined ? "success" : "failure",
    ...(failure === undefined ? {} : { reason: reasonOf(failure) }),
    method,
    userId,
    ...sourceOf(ctx),
  });
}

/** Runs one confirmation of the signed-in user and records it, the refusal rethrown unchanged. */
export async function recordingStepUp<T>(
  ctx: Context,
  method: AuthMethod,
  run: () => Promise<T>,
): Promise<T> {
  const user = await ctx.janus.user();
  if (user === null) throw denial("UNAUTHENTICATED");
  try {
    const done = await run();
    await record(ctx, method, user.id);
    return done;
  } catch (error) {
    await record(ctx, method, user.id, error);
    throw error;
  }
}

/** `requestPasskeyStepUp`: the options for the user's own passkeys. */
export async function requestPasskeyStepUp(ctx: Context) {
  const tenant = await ctx.tenant();
  const auth = await janusIssuers.forRequest(ctx.request);
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
export async function confirmPasskeyStepUp(
  ctx: Context,
  challenge: string,
  response: string,
) {
  const auth = await janusIssuers.forRequest(ctx.request);
  if (auth === null) throw denial("NOT_FOUND", "No such tenant");
  await currentOf(auth, ctx.request);
  const session = await recordingStepUp(ctx, "passkey", () =>
    asPasskeyInvalid(() =>
      auth.stepUp.confirmPasskey(ctx.request, challenge, responseOf(response)),
    ),
  );
  return confirmed(session.authenticatedAt);
}
