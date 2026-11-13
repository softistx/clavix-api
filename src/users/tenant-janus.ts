import { createJanusIssuers, janus } from "@softistx/janus";
import {
  createMongoInvitations,
  createMongoStores,
} from "@softistx/janus-mongo";
import { simpleWebAuthnVerifier } from "@softistx/janus-passkeys";
import type { Db } from "mongodb";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
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
  /** Host to tenant: unknown and suspended hosts resolve to `null`. */
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus collections (`syncMongoStoresPartitioned`). */
  db: Db;
  /** The global magic-link switch (`CLAVIX_MAGIC_LINK`); off when left out. */
  magicLink?: boolean;
  /** What an accepted invitation does on the `clavix` tenant (the console's admins); nothing on the others. */
  onAdminAccepted?: AcceptedHandler;
}

/** `invitations.onAccepted`, as janus calls it. */
export type AcceptedHandler = (accepted: {
  invitation: { scope: string; role: string };
  user: { id: string };
}) => void | Promise<void>;

/** The janus instance of a tenant: its own partition of the user stores (ADR-0006, ADR-0008). */
function buildJanus(
  db: Db,
  tenant: ResolvedTenant,
  magicLink: boolean,
  onAdminAccepted?: AcceptedHandler,
) {
  return janus({
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
    // janus defaults magic-link sign-in to on; Clavix turns it off until the
    // owner switches it on (CLAVIX_MAGIC_LINK, `requestMagicLink` and
    // `confirmMagicLink`). Off, both answer 404 MAGIC_LINK_DISABLED.
    magicLink: { enabled: magicLink },
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
    // are M2: on the `clavix` tenant an invitation is an admin's, and
    // `onAccepted` grants the console relation (scope = the tenant's id, role
    // = owner, admin or viewer). janus claims an invitation once, so the grant
    // runs once; it throws on a role it does not know, which releases the code.
    invitations: {
      store: createMongoInvitations(db, { partition: tenant.partition }),
      create: (invitation) => ({
        email: invitation.email,
        name: invitation.name,
      }),
      onAccepted:
        tenant.slug === PLATFORM_TENANT_SLUG && onAdminAccepted !== undefined
          ? onAdminAccepted
          : () => {},
    },
  });
}

export type TenantJanus = ReturnType<typeof buildJanus>;

export function buildTenantJanus(
  db: Db,
  tenant: ResolvedTenant,
  magicLink = false,
  onAdminAccepted?: AcceptedHandler,
): TenantJanus {
  return buildJanus(db, tenant, magicLink, onAdminAccepted);
}

/**
 * One janus instance per tenant, chosen by host, rebuilt when the tenant's
 * `version` changes. The same resolver feeds the OAuth issuers.
 */
export function createTenantJanusIssuers({
  resolver,
  db,
  magicLink = false,
  onAdminAccepted,
}: TenantJanusOptions) {
  return createJanusIssuers({
    resolve: async (request) => {
      const tenant = await resolver.resolveRequest(request);
      return tenant === null
        ? null
        : { issuer: tenant.issuer, version: String(tenant.version), tenant };
    },
    build: ({ tenant }) =>
      buildTenantJanus(db, tenant, magicLink, onAdminAccepted),
  });
}
