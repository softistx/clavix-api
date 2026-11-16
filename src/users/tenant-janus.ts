import {
  createJanusIssuers,
  janus,
  type SocialConfig,
  type SocialProfile,
} from "@softistx/janus";
import type { SocialAuth } from "@softistx/janus-graphql";
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
  /** What accepting an invitation of this tenant checks and does; nothing when left out. */
  invitationHooks?: InvitationHooksFor;
}

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
  social?: SocialConfig,
  hooks?: InvitationHooks,
) {
  return janus({
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
    // A passkey as the first factor: the relying party is the tenant's own
    // host (`rp.ts`), so a passkey is unknown to every other tenant. janus
    // accepts `http://<name>.localhost` origins, so a development tenant on
    // http (`<slug>.clavix.localhost`) has passkeys like any other.
    passkeys: {
      rpId: rpIdOf(tenant),
      rpName: tenant.name,
      // The slug host's own origin, and each verified custom domain's
      // (WebAuthn Related Origins, ADR-0036): janus-passkeys compares exactly.
      origins: [originOf(tenant), ...tenant.relatedOrigins],
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
export type TenantJanus = ReturnType<typeof buildJanus>;

/** The instance of a tenant with at least one social provider. */
export type TenantSocialJanus = TenantJanus & SocialAuth;

/** The provider's display name when the user schema takes it (1 to 200 characters), else none: it never refuses a sign-up. */
function nameOf(name: string | undefined): { name?: string } {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || trimmed.length > 200 ? {} : { name: trimmed };
}

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
          ...nameOf(profile.name),
        })
      : false,
  };
}

export function buildTenantJanus(
  db: Db,
  tenant: ResolvedTenant,
  secrets?: SecretBox,
  hooks?: InvitationHooks,
): TenantJanus {
  return buildJanus(db, tenant, socialConfigOf(tenant, secrets), hooks);
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
  secrets,
  invitationHooks,
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
      buildTenantJanus(db, tenant, secrets, invitationHooks?.(tenant)),
  });
}
