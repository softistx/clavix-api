import type { OAuthServer } from "@softistx/janus-oauth";
import type { ConsoleAuthenticate } from "./plugin";

/**
 * Verifies a console bearer token in process, against the `clavix` tenant's
 * OAuth server: janus-oauth's `authenticate` checks the signature against the
 * tenant's published keys, expiry, issuer, revocation, the audience (the
 * console resource, so a token for another resource is refused) and that the
 * user and the grant are still live. No HTTP call, no crypto of ours. A
 * missing `clavix` server (the tenant is gone or suspended) is an outage, not
 * a refusal.
 */
export function createConsoleAuthenticator({
  audience,
  serverOfClavix,
}: {
  audience: string;
  serverOfClavix: () => Promise<OAuthServer | null>;
}): ConsoleAuthenticate {
  return async (request) => {
    // No credential at all: nothing to look up, no store read.
    if (
      !request.headers.get("authorization")?.toLowerCase().startsWith("bearer ")
    ) {
      return null;
    }
    const server = await serverOfClavix();
    if (server === null)
      throw new Error("the clavix tenant has no OAuth server");
    const principal = await server.authenticate(request, {
      resource: audience,
    });
    // The `console` scope is the gate: an `openid`-only token is not a console one.
    return principal?.scopes.includes("console") === true ? principal : null;
  };
}
