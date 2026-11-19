import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { janusIssuers } from "@/config/users";
import type { Context } from "@/http/context";
import {
  ACR,
  type Assessment,
  acrOf,
  assess,
  type Demands,
} from "@/oauth/authentication-level";

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
  now: Date = new Date(),
): Promise<Assessment & { authTime: Date }> {
  const [session, user, tenant] = await Promise.all([
    ctx.janus.session(),
    ctx.janus.user(),
    ctx.tenant(),
  ]);
  if (session === null || user === null || tenant === null) {
    throw denial("UNAUTHENTICATED");
  }
  const demands: Demands = {
    acrValues: request.acrValues ?? [],
    maxAge: request.maxAge ?? null,
    prompt: request.prompt ?? [],
    mode: tenant.signIn.mfa.mode,
  };
  // The factors are read only for a session still at one factor.
  let available = true;
  if (acrOf(session.amr) === ACR.first) {
    const auth = await janusIssuers.forRequest(ctx.request);
    if (auth === null) throw denial("NOT_FOUND");
    const [passkeys, codesLeft] = await Promise.all([
      auth.passkeys.list(user),
      auth.secondFactor.recoveryCodesLeft(user),
    ]);
    available = passkeys.length > 0 || codesLeft !== null;
  }
  return {
    ...assess(session, demands, { available }, now),
    authTime: session.authenticatedAt,
  };
}

/** D10: a request the session cannot meet is not approved; the answer carries what is missing so the page can lead the user to it. */
export const unmetAuthentication = (missing: readonly string[]) =>
  new GraphQLError("unmet_authentication_requirements", {
    extensions: {
      code: "UNMET_AUTHENTICATION_REQUIREMENTS",
      oauthError: "unmet_authentication_requirements",
      missing: [...missing],
      http: { status: 403 },
    },
  });

/** The `authentication` field of a pending request. */
export const authenticationOf = async (
  parent: RequestDemands,
  _: unknown,
  ctx: Context,
) => {
  const out = await assessment(ctx, parent);
  return {
    acr: out.required,
    current: out.reached,
    maxAge: out.maxAge,
    met: out.met,
    missing: out.missing,
  };
};
