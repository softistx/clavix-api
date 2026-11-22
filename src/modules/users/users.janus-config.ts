import {
  janus,
  type SealingKey,
  type SocialConfig,
  type UserEventListener,
} from "@softistx/janus";
import {
  createMongoInvitations,
  createMongoStores,
} from "@softistx/janus-mongo";
import { simpleWebAuthnVerifier } from "@softistx/janus-passkeys";
import type { Db } from "mongodb";
import { isEnabled } from "@/modules/sign-in-methods";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { originOf, rpIdOf } from "./users.rp";
import { userSchema } from "./users.schema";
import {
  MAGIC_LINK_LIFESPAN,
  SESSION,
  SESSION_COOKIE,
  SIGN_IN_CODE_LIFESPAN,
} from "./users.session";

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

export type InvitationHooksFor = (tenant: ResolvedTenant) => InvitationHooks;

/**
 * A passkey as the first factor: the relying party is the tenant's own
 * host (`users.rp.ts`), so a passkey is unknown to every other tenant. janus
 * accepts `http://<name>.localhost` origins, so a development tenant on
 * http (`<slug>.clavix.localhost`) has passkeys like any other.
 */
function passkeysOf(tenant: ResolvedTenant) {
  const origins: [string] = [originOf(tenant)];
  return {
    rpId: rpIdOf(tenant),
    rpName: tenant.name,
    // The slug host's own origin; each verified custom domain is a related
    // origin (WebAuthn Related Origins, ADR-0036), on another host than the
    // rpId. `/.well-known/webauthn` serves the same list (`relatedOriginsOf`).
    origins,
    relatedOrigins: tenant.relatedOrigins,
    verifier: simpleWebAuthnVerifier(),
    firstFactor: true as const,
    userVerification: "required" as const,
  };
}

/**
 * How a user enters a tenant that closed sign-up (`tenant.signUp`): the
 * invitation makes the user, e-mail proved. Who may invite and the role are the
 * caller's (`invitationHooks`): what the scope and the role mean, and what
 * accepting grants. janus claims an invitation once, so `onAccepted` runs once.
 */
function invitationsOf(db: Db, tenant: ResolvedTenant, hooks: InvitationHooks) {
  return {
    store: createMongoInvitations(db, { partition: tenant.partition }),
    create: (invitation: { email: string; name?: string | undefined }) => ({
      email: invitation.email,
      name: invitation.name,
    }),
    beforeAccept: hooks.beforeAccept,
    onAccepted: hooks.onAccepted,
  };
}

/** The janus instance of a tenant: its own partition of the user stores (ADR-0006, ADR-0008). */
export function buildJanus(
  db: Db,
  tenant: ResolvedTenant,
  secondFactorKeys: [SealingKey, ...SealingKey[]],
  social: SocialConfig | undefined,
  hooks: InvitationHooks,
  events: UserEventListener,
) {
  return janus({
    events,
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
    // A passkey as the first factor (`passkeysOf`).
    passkeys: passkeysOf(tenant),
    // How a user enters a tenant that closed sign-up (`invitationsOf`).
    invitations: invitationsOf(db, tenant, hooks),
  });
}
