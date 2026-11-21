import {
  createMemoryOAuthStore,
  createOAuthServer,
  type OAuthServer,
} from "@softistx/janus-oauth";
import { acmeJanus } from "~/acme-janus";

/** A real OAuth server over memory stores whose `grants.revokeAll` is `revokeAll` (a copy: the real one is not touched). */
export function serverRevoking(
  revokeAll: OAuthServer["grants"]["revokeAll"],
): OAuthServer {
  const server = createOAuthServer({
    auth: acmeJanus(),
    store: createMemoryOAuthStore(),
    issuer: "https://acme.example.test",
    resources: { "https://api.acme.test/mcp": { scopes: ["read"] } },
  });
  return { ...server, grants: { ...server.grants, revokeAll } };
}
