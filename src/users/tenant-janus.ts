import {
  createJanusIssuers,
  type JanusStores,
  janus,
  type PasskeyFirstFactorApi,
  type PasskeyStore,
  type PasskeysApi,
} from "@softistx/janus";
import {
  createMongoInvitations,
  createMongoStores,
} from "@softistx/janus-mongo";
import { simpleWebAuthnVerifier } from "@softistx/janus-passkeys";
import type { Db } from "mongodb";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import { originOf, passkeysOn, rpIdOf } from "./rp";
import { sealingKeyOf } from "./sealing-key";
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

export interface TenantJanusOptions {
  /** Host to tenant: unknown and suspended hosts resolve to `null`. */
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** The database of the janus collections (`syncMongoStoresPartitioned`). */
  db: Db;
  /** `CLAVIX_KEYS_MASTER_KEY`: janus's sealing key is derived from it (`sealingKeyOf`). */
  masterKey: string;
}

// `createMongoStores` is typed `JanusStores`, whose `passkeys` slot is optional,
// so janus's types hide `auth.passkeys`. The Mongo adapter does carry the slot
// (janus refuses a store without it at wiring): janus-mongo gap, narrowed here.
const passkeyStores = (db: Db, partition: string) =>
  createMongoStores(db, { partition }) as JanusStores & {
    readonly passkeys: PasskeyStore;
  };

/** The janus instance of a tenant: its own partition of the user stores (ADR-0006, ADR-0008). */
function buildJanus(db: Db, tenant: ResolvedTenant, masterKey: string) {
  return janus({
    user: userSchema,
    email: "email",
    store: passkeyStores(db, tenant.partition),
    cookie: { name: SESSION_COOKIE, sameSite: "lax", secure: true },
    session: SESSION,
    // The e-mailed code: 10 minutes, five attempts, five requests per address
    // and 10 minutes (janus's mail throttle, on by default).
    tokens: { signInCode: SIGN_IN_CODE_LIFESPAN },
    // janus's `firstFactor` passkeys still need a second-factor block, whose
    // sealing key would seal a TOTP secret; no TOTP is offered, the key is
    // derived from the master key for that purpose alone.
    secondFactor: { issuer: tenant.name, keys: [sealingKeyOf(masterKey)] },
    // A passkey as the first factor: the relying party is the tenant's own
    // host (`rp.ts`), so a passkey is unknown to every other tenant. janus
    // takes https origins only: a development server on http has no passkeys
    // (the passkey operations answer NOT_FOUND there).
    ...(passkeysOn(tenant)
      ? {
          passkeys: {
            rpId: rpIdOf(tenant),
            rpName: tenant.name,
            origins: [originOf(tenant)],
            verifier: simpleWebAuthnVerifier(),
            firstFactor: true as const,
            userVerification: "required" as const,
          },
        }
      : {}),
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

type BaseJanus = ReturnType<typeof buildJanus>;
type TenantUser = NonNullable<Awaited<ReturnType<BaseJanus["findUser"]>>>;

/**
 * janus's types give `passkeys` only to a user type with a password login; ours
 * is passwordless (the runtime has the API: the specs hold it), so it is added
 * to the type here. janus gap, reported upstream.
 */
export type TenantJanus = BaseJanus &
  PasskeysApi<TenantUser> &
  PasskeyFirstFactorApi<TenantUser>;

export function buildTenantJanus(
  db: Db,
  tenant: ResolvedTenant,
  masterKey: string,
): TenantJanus {
  return buildJanus(db, tenant, masterKey) as TenantJanus;
}

/**
 * One janus instance per tenant, chosen by host, rebuilt when the tenant's
 * `version` changes. The same resolver feeds the OAuth issuers.
 */
export function createTenantJanusIssuers({
  resolver,
  db,
  masterKey,
}: TenantJanusOptions) {
  return createJanusIssuers({
    resolve: async (request) => {
      const tenant = await resolver.resolveRequest(request);
      return tenant === null
        ? null
        : { issuer: tenant.issuer, version: String(tenant.version), tenant };
    },
    build: ({ tenant }) => buildTenantJanus(db, tenant, masterKey),
  });
}
