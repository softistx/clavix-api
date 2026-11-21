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

/** A real OAuth server over memory stores, one resource; the base both doubles below copy. */
const memoryServer = (): OAuthServer =>
  createOAuthServer({
    auth: acmeJanus(),
    store: createMemoryOAuthStore(),
    issuer: "https://acme.example.test",
    resources: { "https://api.acme.test/mcp": { scopes: ["read"] } },
  });

/** What a double replaces on a copy of the real server (the real one is not touched). */
export interface ServerOverrides {
  /** `grants.revokeAll` is this. */
  revokeAll?: OAuthServer["grants"]["revokeAll"];
  /** `authenticateRequest` always answers this principal. */
  principal?: OAuthPrincipal;
}

/** A real OAuth server over memory stores with the members `overrides` names replaced. */
export function oauthServerDouble(
  overrides: ServerOverrides = {},
): OAuthServer {
  const server = memoryServer();
  const { revokeAll, principal } = overrides;
  async function authenticateRequest(
    request: Request,
    options: OAuthClientAuthenticateOptions,
  ): Promise<OAuthAuthentication>;
  async function authenticateRequest(
    request: Request,
    options: OAuthAuthenticateOptions,
  ): Promise<OAuthUserAuthentication>;
  async function authenticateRequest(): Promise<OAuthAuthentication> {
    if (!principal) throw new Error("no principal to answer");
    return { ok: principal };
  }
  return {
    ...server,
    ...(principal ? { authenticateRequest } : {}),
    grants: revokeAll ? { ...server.grants, revokeAll } : server.grants,
  };
}

export const serverRevoking = (
  revokeAll: OAuthServer["grants"]["revokeAll"],
): OAuthServer => oauthServerDouble({ revokeAll });

export const serverAuthenticating = (principal: OAuthPrincipal): OAuthServer =>
  oauthServerDouble({ principal });
