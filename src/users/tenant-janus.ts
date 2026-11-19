import {
  createJanusIssuers,
  janus,
  type SealingKey,
  type SocialConfig,
  SocialError,
  type SocialProfile,
  type SocialProvider,
  type StepUpPasskeyApi,
  type UserEventListener,
} from "@softistx/janus";
import type { SocialAuth } from "@softistx/janus-graphql";
import {
  createMongoInvitations,
  createMongoStores,
} from "@softistx/janus-mongo";
import { simpleWebAuthnVerifier } from "@softistx/janus-passkeys";
import {
  type ConnectionSource,
  type OidcConnections,
  type OidcConnectionsOptions,
  oidcConnections,
} from "@softistx/janus-social";
import { instrumentJanus } from "@softistx/janus-telemetry";
import type { Db } from "mongodb";
import type { SecretBox } from "@/modules/sign-in-methods/secrets";
import { isEnabled } from "@/modules/sign-in-methods/sign-in.schema";
import { socialProvidersOf } from "@/modules/sign-in-methods/social";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { originOf, rpIdOf } from "./rp";
import { ephemeralSecondFactorKeys } from "./second-factor-keys";
import { userSchema } from "./user";

/** Host-only, `__Host-` prefixed: no Domain, Secure, Path=/ (janus's defaults), so a browser never sends it to another host. */
export const SESSION_COOKIE = "__Host-clavix-session";

/**
 * Assumed (owner decisions of 2026-11-12, clavix-api#24): 14 days sliding,
 * renewed once a day, and never more than 30 days after sign-in (`absolute`).
 */
export const SESSION = {
  lifespan: "14d",
  renewAfter: "1d",
  absolute: "30d",
} as const;

/** How long a sign-in code, and its challenge, can be confirmed (janus's default, stated). */
export const SIGN_IN_CODE_LIFESPAN = "10m";

/** How long a sign-in link can be confirmed (janus's default, stated). */
export const MAGIC_LINK_LIFESPAN = "15m";

export interface TenantJanusOptions {
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus collections (`syncMongoStoresPartitioned`). */
  db: Db;
  /**
   * The sealing keys of the TOTP secrets and recovery codes
   * (`secondFactorKeysOf(masterKeys)`): the first seals, every one opens.
   */
  secondFactorKeys?: [SealingKey, ...SealingKey[]];
  /** Opens the tenants' sealed social secrets; without it no tenant has a social provider. */
  secrets?: SecretBox;
  /** The tenants' enterprise OIDC connections (M4, F1); without it no tenant has one. */
  connections?: ConnectionsOf;
  /** What accepting an invitation of this tenant checks and does; nothing when left out. */
  invitationHooks?: InvitationHooksFor;
  /** Hears the user events of one tenant's instance (D12); nothing when left out. */
  events?: (tenant: ResolvedTenant) => UserEventListener;
}

/** Where a tenant's enterprise OIDC connections are read (`ConnectionsService`). */
export interface ConnectionsOf {
  sourceOf(tenantId: string): ConnectionSource;
  /** Specs only: the host resolver of the guard's address check; DNS when absent. */
  resolveHost?(): OidcConnectionsOptions["resolveHost"];
  /** Whether a connection may create a user at a first sign-in (D4); read on every sign-up. */
  jitAllowed(tenantId: string, connectionId: string): Promise<boolean>;
}

/** The path, on the tenant's issuer host, where an identity provider sends the visitor back: one URL for every connection of the tenant. */
export const ssoCallbackUrlOf = (issuer: string) =>
  `${issuer}/sign-in/sso/callback`;

/** janus's `invitations.beforeAccept` and `onAccepted` of one tenant. */
export interface InvitationHooks {
  /** `false` refuses (`INVITATION_REFUSED`), nothing written. Free of side effects. */
  beforeAccept(accepting: {
    invitation: { scope: string; role: string };
  }): boolean | Promise<boolean>;
  /** Runs once per accepted invitation; throwing releases it. */
  onAccepted(accepted: {
    invitation: { scope: string; role: string };
    user: { id: string };
  }): void | Promise<void>;
}

export type InvitationHooksFor = (
  tenant: ResolvedTenant,
) => InvitationHooks | undefined;

/** The janus instance of a tenant: its own partition of the user stores (ADR-0006, ADR-0008). */
function buildJanus(
  db: Db,
  tenant: ResolvedTenant,
  secondFactorKeys: [SealingKey, ...SealingKey[]],
  social?: SocialConfig,
  hooks?: InvitationHooks,
  events?: UserEventListener,
) {
  return janus({
    ...(events === undefined ? {} : { events }),
    // janus refuses a social config with no provider: such a tenant gets none.
    ...(social === undefined ? {} : { social }),
    user: userSchema,
    email: "email",
    store: createMongoStores(db, { partition: tenant.partition }),
    cookie: { name: SESSION_COOKIE, sameSite: "lax", secure: true },
    session: SESSION,
    // The e-mailed code: 10 minutes, five attempts, five requests per address
    // and 10 minutes (janus's mail throttle, on by default).
    tokens: {
      signInCode: SIGN_IN_CODE_LIFESPAN,
      magicLink: MAGIC_LINK_LIFESPAN,
    },
    // janus defaults magic-link sign-in to on; Clavix passes the tenant's own
    // choice (its sign-in policy, off until it turns it on). Off,
    // `requestMagicLink` and `confirmMagicLink` answer 404 MAGIC_LINK_DISABLED.
    magicLink: { enabled: isEnabled(tenant.signIn, "magicLink") },
    // The TOTP second factor (D8), always wired: a user who holds an active one
    // is asked for the code whatever the tenant's policy says now (janus fails
    // closed without it), and the policy's `mfa.totp` only gates the
    // enrolment (the hosted `guard`, `src/modules/mfa`). The tenant's name is
    // what the authenticator app shows.
    secondFactor: {
      issuer: tenant.name,
      keys: secondFactorKeys,
    },
    // A passkey as the first factor: the relying party is the tenant's own
    // host (`rp.ts`), so a passkey is unknown to every other tenant. janus
    // accepts `http://<name>.localhost` origins, so a development tenant on
    // http (`<slug>.clavix.localhost`) has passkeys like any other.
    passkeys: {
      rpId: rpIdOf(tenant),
      rpName: tenant.name,
      // The slug host's own origin; each verified custom domain is a related
      // origin (WebAuthn Related Origins, ADR-0036), on another host than the
      // rpId. `/.well-known/webauthn` serves the same list (`relatedOriginsOf`).
      origins: [originOf(tenant)],
      relatedOrigins: tenant.relatedOrigins,
      verifier: simpleWebAuthnVerifier(),
      firstFactor: true as const,
      userVerification: "required" as const,
    },
    // How a user enters a tenant that closed sign-up (`tenant.signUp`): the
    // invitation makes the user, e-mail proved. Who may invite and the role
    // are the caller's (`invitationHooks`): what the scope and the role mean,
    // and what accepting grants. janus claims an invitation once, so
    // `onAccepted` runs once.
    invitations: {
      store: createMongoInvitations(db, { partition: tenant.partition }),
      create: (invitation) => ({
        email: invitation.email,
        name: invitation.name,
      }),
      ...(hooks === undefined ? {} : { beforeAccept: hooks.beforeAccept }),
      onAccepted: hooks?.onAccepted ?? (() => {}),
    },
  });
}

/** The typed shape of a tenant's instance. It has no `social`: only a tenant with a provider does, reached through `socialOf`. */
type BuiltJanus = ReturnType<typeof buildJanus>;
export type TenantJanus = BuiltJanus &
  StepUpPasskeyApi<NonNullable<Awaited<ReturnType<BuiltJanus["findUser"]>>>>;

/**
 * The instance of a tenant with at least one social provider. janus-graphql's
 * `SocialAuth` leaves `countLinks` out of its narrow `social`; the instance has it.
 */
export type TenantSocialJanus = TenantJanus &
  SocialAuth & {
    readonly social: {
      countLinks(query: { readonly provider: string }): Promise<number>;
    };
  };

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
  connections: ConnectionsOf | undefined,
): OidcConnections | undefined {
  if (connections === undefined) return undefined;
  try {
    const resolveHost = connections.resolveHost?.();
    return oidcConnections({
      source: connections.sourceOf(tenant.tenantId),
      ...(resolveHost === undefined ? {} : { resolveHost }),
      redirectUri: ssoCallbackUrlOf(tenant.issuer),
    });
  } catch (error) {
    console.warn(
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

/** The connections each instance was built with: one `oidcConnections` per instance, shared by sign-in and discovery. */
const homeRealms = new WeakMap<object, OidcConnections>();

/**
 * Home-realm discovery on the tenant's own instance (F2): the id of the
 * connection that owns the address's domain, or `null`. It reveals that a
 * domain has single sign-on: the caller throttles it.
 */
export const homeRealmOf = (
  auth: TenantJanus,
  email: string,
): Promise<string | null> =>
  homeRealms.get(auth)?.forEmail(email) ?? Promise.resolve(null);

/**
 * The new user's fields, or the refusal: through a connection, the connection's
 * own `jit` decides (D4, even where the tenant closed sign-up); through a
 * static social app, the tenant's sign-up policy does.
 */
function signUpOf(
  tenant: ResolvedTenant,
  hasStatic: (provider: string) => boolean,
  connections: ConnectionsOf | undefined,
) {
  return async (profile: SocialProfile) => {
    const allowed = hasStatic(profile.provider)
      ? tenant.signUp
      : (await connections?.jitAllowed(tenant.tenantId, profile.provider)) ===
        true;
    if (!allowed) {
      throw new SocialError(
        "SIGN_UP_DISABLED",
        "social sign-up is not open for this provider",
      );
    }
    return { email: profile.email ?? "", ...nameOf(profile.name) };
  };
}

/** The tenant's own social apps (ADR-0035) and enterprise connections. A new user: through a connection when its `jit` is on, through a static app only where sign-up is open. */
function socialConfigOf(
  tenant: ResolvedTenant,
  secrets: SecretBox | undefined,
  connections?: ConnectionsOf,
): { config: SocialConfig | undefined; realms?: OidcConnections } {
  const providers =
    secrets === undefined
      ? {}
      : socialProvidersOf(tenant, secrets, (provider, reason) =>
          console.warn(
            `social: ${provider} of tenant ${tenant.tenantId} is off (${reason})`,
          ),
        );
  const realms = connectionsOfTenant(tenant, connections);
  const hasStatic = Object.keys(providers).length > 0;
  if (!hasStatic && realms === undefined) return { config: undefined };
  return {
    config: {
      ...(hasStatic ? { providers } : {}),
      ...(realms === undefined || connections === undefined
        ? {}
        : {
            resolveProvider: trustingUpstreamMfa(
              realms.resolve,
              connections.sourceOf(tenant.tenantId),
            ),
          }),
      signUp:
        realms === undefined && !tenant.signUp
          ? (false as const)
          : signUpOf(
              tenant,
              (name) => Object.hasOwn(providers, name),
              connections,
            ),
    } as SocialConfig,
    ...(realms === undefined ? {} : { realms }),
  };
}

export function buildTenantJanus(
  db: Db,
  tenant: ResolvedTenant,
  secrets?: SecretBox,
  hooks?: InvitationHooks,
  events?: UserEventListener,
  // Specs only: the server always passes the keyring's (`createTenantJanusIssuers`).
  secondFactorKeys: [SealingKey, ...SealingKey[]] = ephemeralSecondFactorKeys(),
  connections?: ConnectionsOf,
): TenantJanus {
  const { config, realms } = socialConfigOf(tenant, secrets, connections);
  // Traced (D24): a span per flow, the security events as logs; neither names an address or a login.
  const instance = instrumentJanus(
    buildJanus(db, tenant, secondFactorKeys, config, hooks, events),
  );
  if (realms !== undefined) homeRealms.set(instance, realms);
  // janus answers `stepUp.request(user, { via: "passkey" })` and `confirmPasskey`
  // for an instance with passkeys and a second factor (both wired above), but
  // its inferred type leaves them out: `StepUpPasskeyApi` names them.
  return instance as TenantJanus;
}

/** The instance when the tenant has at least one social provider, else `null`. */
export const socialOf = (auth: TenantJanus): TenantSocialJanus | null =>
  "social" in auth && auth.social !== undefined
    ? (auth as TenantSocialJanus)
    : null;

/** A short stable digest of the related origins, for the instance cache's version. */
const fingerprintOf = (origins: readonly string[]): string =>
  new Bun.CryptoHasher("sha256")
    .update([...origins].sort().join("\n"))
    .digest("hex")
    .slice(0, 12);

/**
 * One janus instance per tenant, chosen by host, rebuilt when the tenant's
 * `version` or its related origins change. The same resolver feeds the OAuth issuers.
 */
export function createTenantJanusIssuers({
  resolver,
  db,
  secondFactorKeys = ephemeralSecondFactorKeys(),
  secrets,
  connections,
  invitationHooks,
  events,
}: TenantJanusOptions) {
  return createJanusIssuers({
    resolve: async (request) => {
      const tenant = await resolver.resolveRequest(request);
      return tenant === null
        ? null
        : {
            issuer: tenant.issuer,
            // `origins` is fixed when the instance is built, so the version
            // also carries the related origins: verifying or removing a domain
            // rebuilds the cached instance (ADR-0036).
            version: `${tenant.version}.${fingerprintOf(tenant.relatedOrigins)}`,
            tenant,
          };
    },
    build: ({ tenant }) =>
      buildTenantJanus(
        db,
        tenant,
        secrets,
        invitationHooks?.(tenant),
        events?.(tenant),
        secondFactorKeys,
        connections,
      ),
  });
}
