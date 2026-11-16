import { createOAuthServer, type OAuthStore } from "@softistx/janus-oauth";

/**
 * The deletion of a client by janus's `oauth.deleteClient`: the record goes
 * first, then its grants and tokens (exchanged ones included) are revoked.
 * The server is built for that call alone: deleting reads the store and the
 * clock, never the issuer, the resources or the sign-in, so those are
 * placeholders that no request ever reaches. Resolves to whether a record was
 * deleted; a store without `revokeClientGrants` throws a `TypeError` and
 * leaves the client intact.
 */
export function deleteClientRevoking(
  store: OAuthStore,
  clientId: string,
  now: () => Date,
): Promise<boolean> {
  const oauth = createOAuthServer({
    auth: {
      authenticate: async () => null,
      findUser: async () => null,
    },
    store,
    issuer: "https://client-deletion.invalid",
    resources: { "https://client-deletion.invalid/api": { scopes: ["none"] } },
    clock: { now },
  });
  return oauth.deleteClient(clientId);
}
