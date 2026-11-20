import type { OAuthServer } from "@softistx/janus-oauth";
import { CONSOLE_CLIENT_ID } from "./identity";
import type { ConsoleAuthenticate } from "./plugin";

/** `Authorization: Bearer …` or `DPoP …`: the two schemes the console accepts. */
const presents = (request: Request) => {
  const header = request.headers.get("authorization")?.toLowerCase() ?? "";
  return header.startsWith("bearer ") || header.startsWith("dpop ");
};

/**
 * Verifies a console bearer token in process, against the `clavix` tenant's
 * OAuth server: janus-oauth's `authenticate` checks the signature against the
 * tenant's published keys, expiry, issuer, revocation, the audience (the
 * console resource, so a token for another resource is refused) and that the
 * user and the grant are still live. No HTTP call, no crypto of ours. A
 * missing `clavix` server (the tenant is gone or suspended) is an outage, not
 * a refusal.
 *
 * Both `Authorization: Bearer` and `Authorization: DPoP` (RFC 9449) are
 * accepted: janus-oauth's `authenticateRequest` checks a bound token's proof
 * (method, URL, `ath`, replay, nonce) against `publicUrl`, the URL the client
 * called, never the one the proxy forwards to (the proof's `htu` is the public
 * one). A token exchanged for an actor (`act` claim) is refused with a plain
 * 401, whatever its scheme. A bound token sent as Bearer is refused, and a refused DPoP request
 * answers its challenge (`use_dpop_nonce` carries the nonce to retry with).
 */
export function createConsoleAuthenticator({
  audience,
  publicUrl,
  serverOfClavix,
}: {
  audience: string;
  /** The console API's public URL (`https://console.<domain>/console/graphql`), the proof's `htu`. */
  publicUrl: string;
  serverOfClavix: () => Promise<OAuthServer | null>;
}): ConsoleAuthenticate {
  return async (request, path) => {
    // No credential at all: nothing to look up, no store read.
    if (!presents(request)) return null;
    const server = await serverOfClavix();
    if (server === null)
      throw new Error("the clavix tenant has no OAuth server");
    const result = await server.authenticateRequest(
      {
        headers: request.headers,
        method: request.method,
        url: path === undefined ? publicUrl : new URL(path, publicUrl).href,
      },
      { resource: audience },
    );
    if ("refused" in result) {
      const { scheme, error, description, nonce } = result.refused;
      return scheme === "DPoP"
        ? { refused: { error, description, nonce } }
        : null;
    }
    const principal = result.ok;
    // The console client alone: another client of the `clavix` tenant can be
    // granted the console audience, and its token is not an operator's.
    if (principal?.clientId !== CONSOLE_CLIENT_ID) return null;
    // An operator, not a machine: a token with no user behind it is refused
    // (janus-oauth answers a client-only token only to a caller that opts in with `clientCredentials`, which the console never does; the check keeps it so).
    if (typeof principal.userId !== "string" || principal.userId === "") {
      return null;
    }
    // A delegated (RFC 8693 exchanged) token carries an actor: someone acts for
    // the operator. The console takes the operator's own token only, so a
    // token handed to another party (or a service) never reaches it.
    if (principal.actor !== undefined) return null;
    // The `console` scope is the gate: an `openid`-only token is not a console one.
    return principal.scopes.includes("console") === true ? principal : null;
  };
}
