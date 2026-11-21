import { janusIssuers } from "@/config/users";
import type { Context } from "@/http/context";
import {
  ACR,
  type Assessment,
  acrOf,
  assess,
  type Demands,
} from "@/oauth/authentication-level";
import { fail } from "@/shared/errors";

/** What a pending request asks of the authentication: its `acr_values`, `max_age` and `prompt`. The device flow's request carries none. */
export interface RequestDemands {
  acrValues?: readonly string[] | null;
  maxAge?: number | null;
  prompt?: readonly string[] | null;
}

/**
 * Whether the viewer's session meets the tenant's mode (D7) and the request
 * (D10), and what the approval states: its `acr` and `amr`. The session is the
 * one the cookie names, so a request of another tenant never reaches here.
 */
export async function assessment(
  ctx: Context,
  request: RequestDemands,
  now: Date,
): Promise<Assessment & { authTime: Date }> {
  const [session, user, tenant] = await Promise.all([
    ctx.janus.session(),
    ctx.janus.user(),
    ctx.tenant(),
  ]);
  if (session === null || user === null || tenant === null) {
    throw fail("UNAUTHENTICATED", "Not signed in", { status: 401 });
  }
  const demands: Demands = {
    acrValues: request.acrValues ?? [],
    maxAge: request.maxAge ?? null,
    prompt: request.prompt ?? [],
    mode: tenant.signIn.mfa.mode,
  };
  // The factors are read only for a session short of the strongest level.
  let available = true;
  let passkey = true;
  if (acrOf(session.amr) !== ACR.phishingResistant) {
    const auth = await janusIssuers.forRequest(ctx.request);
    if (auth === null) throw fail("NOT_FOUND", "Not found", { status: 404 });
    const [passkeys, codesLeft] = await Promise.all([
      auth.passkeys.list(user),
      auth.secondFactor.recoveryCodesLeft(user),
    ]);
    available = passkeys.length > 0 || codesLeft !== null;
    passkey = passkeys.length > 0;
  }
  return {
    ...assess(session, demands, { available, passkey }, now),
    authTime: session.authenticatedAt,
  };
}
