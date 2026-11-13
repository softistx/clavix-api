import {
  createJanusIssuers,
  janus,
  type SocialConfig,
  type SocialProfile,
} from "@softistx/janus";
import {
  createMongoInvitations,
  createMongoStores,
} from "@softistx/janus-mongo";
import { simpleWebAuthnVerifier } from "@softistx/janus-passkeys";
import type { Db } from "mongodb";
import type { SecretBox } from "@/modules/sign-in-methods/secrets";
import { isEnabled } from "@/modules/sign-in-methods/sign-in.schema";
import { socialProvidersOf } from "@/modules/sign-in-methods/social";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { originOf, rpIdOf } from "./rp";
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
  /** Opens the tenants' sealed social secrets; without it no tenant has a social provider. */
  secrets?: SecretBox;
}

/** The janus instance of a tenant: its own partition of the user stores (ADR-0006, ADR-0008). */
function buildJanus(db: Db, tenant: ResolvedTenant, social?: SocialConfig) {
  return janus({
    // janus refuses a social config with no provider: such a tenant gets none
    // (`undefined`, typed as if present; `socialOf` guards every use).
    social: social as SocialConfig,
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
    // A passkey as the first factor: the relying party is the tenant's own
    // host (`rp.ts`), so a passkey is unknown to every other tenant. janus
    // accepts `http://<name>.localhost` origins, so a development tenant on
    // http (`<slug>.clavix.localhost`) has passkeys like any other.
    passkeys: {
      rpId: rpIdOf(tenant),
      rpName: tenant.name,
      origins: [originOf(tenant)],
      verifier: simpleWebAuthnVerifier(),
      firstFactor: true as const,
      userVerification: "required" as const,
    },
    // How a user enters a tenant that closed sign-up (`tenant.signUp`): the
    // invitation makes the user, e-mail proved. Who may invite and the role
    // are M2 (`onAccepted` adds the membership then).
    invitations: {
      store: createMongoInvitations(db, { partition: tenant.partition }),
      create: (invitation) => ({
        email: invitation.email,
        name: invitation.name,
      }),
      onAccepted: () => {},
    },
  });
}

/** The typed shape of a tenant's instance. `social` is typed as present but absent at runtime for a tenant with no provider: reach it through `socialOf`. */
export type TenantJanus = ReturnType<typeof buildJanus>;

/** The tenant's own social apps (ADR-0035); a new user only where sign-up is open. */
function socialConfigOf(
  tenant: ResolvedTenant,
  secrets: SecretBox | undefined,
): SocialConfig | undefined {
  if (secrets === undefined) return undefined;
  const providers = socialProvidersOf(tenant, secrets, (provider, reason) =>
    console.warn(
      `social: ${provider} of tenant ${tenant.tenantId} is off (${reason})`,
    ),
  );
  if (Object.keys(providers).length === 0) return undefined;
  return {
    providers,
    signUp: tenant.signUp
      ? (profile: SocialProfile) => ({
          email: profile.email ?? "",
          ...(profile.name === undefined ? {} : { name: profile.name }),
        })
      : false,
  };
}

export function buildTenantJanus(
  db: Db,
  tenant: ResolvedTenant,
  secrets?: SecretBox,
): TenantJanus {
  return buildJanus(db, tenant, socialConfigOf(tenant, secrets));
}

/** The instance when the tenant has at least one social provider, else `null`. */
export const socialOf = (auth: TenantJanus): TenantJanus | null =>
  (auth as { social?: unknown }).social === undefined ? null : auth;

/**
 * One janus instance per tenant, chosen by host, rebuilt when the tenant's
 * `version` changes. The same resolver feeds the OAuth issuers.
 */
export function createTenantJanusIssuers({
  resolver,
  db,
  secrets,
}: TenantJanusOptions) {
  return createJanusIssuers({
    resolve: async (request) => {
      const tenant = await resolver.resolveRequest(request);
      return tenant === null
        ? null
        : { issuer: tenant.issuer, version: String(tenant.version), tenant };
    },
    build: ({ tenant }) => buildTenantJanus(db, tenant, secrets),
  });
}
