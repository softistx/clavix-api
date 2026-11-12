import { createJanusIssuers, janus } from "@softistx/janus";
import {
  createMongoInvitations,
  createMongoStores,
} from "@softistx/janus-mongo";
import type { Db } from "mongodb";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { userSchema } from "./user";

/** Host-only, `__Host-` prefixed: no Domain, Secure, Path=/ (janus's defaults), so a browser never sends it to another host. */
export const SESSION_COOKIE = "__Host-clavix-session";

/**
 * Assumed (owner decisions of 2026-11-12, clavix-api#24): 14 days sliding,
 * renewed once a day. The 30-day absolute cap is not enforced: janus 0.52 has
 * no such option (see AGENTS.md).
 */
export const SESSION = { lifespan: "14d", renewAfter: "1d" } as const;

/** How long a sign-in code, and its challenge, can be confirmed (janus's default, stated). */
export const SIGN_IN_CODE_LIFESPAN = "10m";

export interface TenantJanusOptions {
  /** Host to tenant: unknown and suspended hosts resolve to `null`. */
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus collections (`syncMongoStoresPartitioned`). */
  db: Db;
}

/** The janus instance of a tenant: its own partition of the user stores (ADR-0006, ADR-0008). */
export function buildTenantJanus(db: Db, tenant: ResolvedTenant) {
  return janus({
    user: userSchema,
    email: "email",
    store: createMongoStores(db, { partition: tenant.partition }),
    cookie: { name: SESSION_COOKIE, sameSite: "lax", secure: true },
    session: SESSION,
    // The e-mailed code: 10 minutes, five attempts, five requests per address
    // and 10 minutes (janus's mail throttle, on by default).
    tokens: { signInCode: SIGN_IN_CODE_LIFESPAN },
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

export type TenantJanus = ReturnType<typeof buildTenantJanus>;

/**
 * One janus instance per tenant, chosen by host, rebuilt when the tenant's
 * `version` changes. The same resolver feeds the OAuth issuers.
 */
export function createTenantJanusIssuers({ resolver, db }: TenantJanusOptions) {
  return createJanusIssuers({
    resolve: async (request) => {
      const tenant = await resolver.resolveRequest(request);
      return tenant === null
        ? null
        : { issuer: tenant.issuer, version: String(tenant.version), tenant };
    },
    build: ({ tenant }) => buildTenantJanus(db, tenant),
  });
}
