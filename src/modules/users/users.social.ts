import {
  type SocialConfig,
  SocialError,
  type SocialProfile,
  type SocialProvider,
  type SocialUnverifiedHolder,
} from "@softistx/janus";
import {
  type ConnectionSource,
  type OidcConnections,
  type OidcConnectionsOptions,
  oidcConnections,
} from "@softistx/janus-social";
import type { SecretBox } from "@/modules/sign-in-methods";
import { callbackUrlOf, socialProvidersOf } from "@/modules/sign-in-methods";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

/** Where a tenant's enterprise OIDC connections are read (`ConnectionSourcesService`). */
export interface ConnectionsOf {
  sourceOf(tenantId: string): ConnectionSource;
  /** The host resolver of the guard's address check; `undefined`: janus's own (DNS). */
  resolveHost(): OidcConnectionsOptions["resolveHost"];
  /** The transport of the requests to an identity provider; `undefined`: janus's own. */
  fetch(): OidcConnectionsOptions["fetch"];
  /** Whether a connection may create a user at a first sign-in (D4); read on every sign-up. */
  jitAllowed(tenantId: string, connectionId: string): Promise<boolean>;
}

/** The provider's display name when the user schema takes it (1 to 200 characters), else none: it never refuses a sign-up. */
function nameOf(name: string | undefined): { name?: string } {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || trimmed.length > 200 ? {} : { name: trimmed };
}

/**
 * The tenant's enterprise connections (D1): janus asks `resolve` for any
 * provider name the static social apps do not own, and it reads the
 * connection on every call. `forEmail` is the home-realm discovery. `undefined`
 * when the tenant's redirect URI is one janus refuses (https, or http on a
 * loopback host), so a development tenant on another http host loses its
 * connections rather than its whole instance.
 */
function connectionsOfTenant(
  tenant: ResolvedTenant,
  connections: ConnectionsOf,
  log: (message: string) => void,
): OidcConnections | undefined {
  try {
    const resolveHost = connections.resolveHost();
    const fetcher = connections.fetch();
    return oidcConnections({
      source: connections.sourceOf(tenant.tenantId),
      ...(resolveHost === undefined ? {} : { resolveHost }),
      ...(fetcher === undefined ? {} : { fetch: fetcher }),
      redirectUri: (connection) => callbackUrlOf(tenant.issuer, connection.id),
    });
  } catch (error) {
    log(
      `connections: tenant ${tenant.tenantId} has none (${error instanceof Error ? error.name : "unknown error"})`,
    );
    return undefined;
  }
}

/**
 * D6: a connection whose `upstreamMfa.acr` is set asks the identity provider
 * for that `acr` (a sign-in whose ID token holds another is refused), so a
 * sign-in that completes is one the identity provider proved at that level:
 * its session records `mfa` beside `fed` and reaches the `mfa` level. A
 * connection with none records `fed` alone.
 */
function trustingUpstreamMfa(
  resolve: (name: string) => Promise<SocialProvider | null>,
  source: ConnectionSource,
) {
  return async (name: string): Promise<SocialProvider | null> => {
    const provider = await resolve(name);
    if (provider === null) return null;
    const connection = await source.findConnection(name);
    const acrValues = connection?.stepUp?.acrValues;
    if (acrValues === undefined || acrValues.length === 0) return provider;
    return {
      ...provider,
      federatedAmr: {
        acr: Object.fromEntries(acrValues.map((acr) => [acr, ["mfa"]])),
      },
    };
  };
}

/**
 * The new user's fields, or the refusal: through a connection, the connection's
 * own `jit` decides (D4, even where the tenant closed sign-up); through a
 * static social app, the tenant's sign-up policy does.
 */
function signUpOf(
  tenant: ResolvedTenant,
  hasStatic: (provider: string) => boolean,
  connections: ConnectionsOf,
) {
  return async (profile: SocialProfile) => {
    const allowed = hasStatic(profile.provider)
      ? tenant.signUp
      : await connections.jitAllowed(tenant.tenantId, profile.provider);
    if (!allowed) {
      throw new SocialError(
        "SIGN_UP_DISABLED",
        "social sign-up is not open for this provider",
      );
    }
    return { email: profile.email ?? "", ...nameOf(profile.name) };
  };
}

/**
 * What a provider-verified sign-in does with a user who holds the e-mail and
 * never proved it (janus `social.unverifiedHolder`; nxgt-janus #978). The
 * built-in social apps (Google, GitHub, Microsoft) vouch for the addresses
 * they hold: their proof replaces the holder. An enterprise connection is the
 * tenant's own identity provider, which may vouch for an address it does not
 * control: it is refused. janus asks only once the provider reported the
 * e-mail as verified. Answered from this configuration, never from the request.
 */
export const unverifiedHolderOf =
  (hasStatic: (provider: string) => boolean): SocialUnverifiedHolder =>
  (_holder, profile) =>
    hasStatic(profile.provider) ? "replace" : "refuse";

/** The tenant's own social apps (ADR-0035) and enterprise connections. A new user: through a connection when its `jit` is on, through a static app only where sign-up is open. */
export function socialConfigOf(
  tenant: ResolvedTenant,
  secrets: SecretBox,
  log: (message: string) => void,
  connections: ConnectionsOf,
): { config: SocialConfig | undefined; realms?: OidcConnections } {
  const providers = socialProvidersOf(tenant, secrets, (provider, reason) =>
    log(`social: ${provider} of tenant ${tenant.tenantId} is off (${reason})`),
  );
  const realms = connectionsOfTenant(tenant, connections, log);
  const hasStatic = Object.keys(providers).length > 0;
  if (!hasStatic && realms === undefined) return { config: undefined };
  const options = {
    unverifiedHolder: unverifiedHolderOf((name) =>
      Object.hasOwn(providers, name),
    ),
    signUp:
      realms === undefined && !tenant.signUp
        ? (false as const)
        : signUpOf(
            tenant,
            (name) => Object.hasOwn(providers, name),
            connections,
          ),
  };
  if (realms === undefined) {
    return { config: { ...options, providers } };
  }
  const resolveProvider = trustingUpstreamMfa(
    realms.resolve,
    connections.sourceOf(tenant.tenantId),
  );
  const config: SocialConfig = hasStatic
    ? { ...options, providers, resolveProvider }
    : { ...options, resolveProvider };
  return { config, realms };
}
