import type { OidcConnections } from "@softistx/janus-social";

const SSO_CALLBACK_PATH = /^\/sign-in\/social\/([^/]+)\/callback$/;

/**
 * The connection a callback URL names, read from its path: `null` for any
 * other path. The URL is the one the identity provider redirected the visitor
 * to, so the id is the callback's own, never a claim.
 */
export function connectionIdOfCallbackUrl(callbackUrl: string): string | null {
  try {
    const match = SSO_CALLBACK_PATH.exec(new URL(callbackUrl).pathname);
    return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Remembers the connections an instance was built with, for `homeRealmOf` and `bindSsoCallback`. */
export const rememberRealms = (auth: object, realms: OidcConnections): void => {
  homeRealms.set(auth, realms);
};

/** The connections each instance was built with: one `oidcConnections` per instance, shared by sign-in and discovery. */
const homeRealms = new WeakMap<object, OidcConnections>();

/**
 * Home-realm discovery on the tenant's own instance (F2): the id of the
 * connection that owns the address's domain, or `null`. It reveals that a
 * domain has single sign-on: the caller throttles it.
 */
export const homeRealmOf = (
  auth: object,
  email: string,
): Promise<string | null> =>
  homeRealms.get(auth)?.forEmail(email) ?? Promise.resolve(null);

/**
 * Binds a callback's parameters to the connection whose URL received them
 * (janus-social `connections.callback`, nxgt-janus#987). A tenant with no
 * connections answers the parameters unbound: a connection's flow is then
 * refused, and a static app's is unaffected.
 */
export function bindSsoCallback(
  auth: object,
  connectionId: string,
  callback: URLSearchParams,
): URLSearchParams {
  const realms = homeRealms.get(auth);
  return realms === undefined
    ? callback
    : realms.callback(connectionId, callback);
}
