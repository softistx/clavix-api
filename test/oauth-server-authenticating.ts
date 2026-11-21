import {
  createMemoryOAuthStore,
  createOAuthServer,
  type OAuthAuthenticateOptions,
  type OAuthAuthentication,
  type OAuthClientAuthenticateOptions,
  type OAuthPrincipal,
  type OAuthServer,
  type OAuthUserAuthentication,
} from "@softistx/janus-oauth";
import { acmeJanus } from "~/acme-janus";

/** A real OAuth server over memory stores whose `authenticateRequest` always answers `principal` (a copy: the real one is not touched). */
export function serverAuthenticating(principal: OAuthPrincipal): OAuthServer {
  const server = createOAuthServer({
    auth: acmeJanus(),
    store: createMemoryOAuthStore(),
    issuer: "https://acme.example.test",
    resources: { "https://api.acme.test/mcp": { scopes: ["read"] } },
  });
  async function authenticateRequest(
    request: Request,
    options: OAuthClientAuthenticateOptions,
  ): Promise<OAuthAuthentication>;
  async function authenticateRequest(
    request: Request,
    options: OAuthAuthenticateOptions,
  ): Promise<OAuthUserAuthentication>;
  async function authenticateRequest(): Promise<OAuthAuthentication> {
    return { ok: principal };
  }
  return { ...server, authenticateRequest };
}
