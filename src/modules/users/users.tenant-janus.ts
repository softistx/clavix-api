import {
  janus,
  type PasskeySignInApi,
  type SealingKey,
  type SocialConfig,
  type StepUpPasskeyApi,
  type UserEventListener,
} from "@softistx/janus";
import type { SocialAuth } from "@softistx/janus-graphql";
import {
  createMongoInvitations,
  createMongoStores,
} from "@softistx/janus-mongo";
import { simpleWebAuthnVerifier } from "@softistx/janus-passkeys";
import { instrumentJanus } from "@softistx/janus-telemetry";
import type { Db } from "mongodb";
import type { SecretBox } from "@/modules/sign-in-methods";
import { isEnabled } from "@/modules/sign-in-methods";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { originOf, rpIdOf } from "./users.rp";
import { userSchema } from "./users.schema";
import { ephemeralSecondFactorKeys } from "./users.second-factor-keys";
import {
  MAGIC_LINK_LIFESPAN,
  SESSION,
  SESSION_COOKIE,
  SIGN_IN_CODE_LIFESPAN,
} from "./users.session";
import { type ConnectionsOf, socialConfigOf } from "./users.social";
import { rememberRealms } from "./users.sso";

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

/**
 * A passkey as the first factor: the relying party is the tenant's own
 * host (`users.rp.ts`), so a passkey is unknown to every other tenant. janus
 * accepts `http://<name>.localhost` origins, so a development tenant on
 * http (`<slug>.clavix.localhost`) has passkeys like any other.
 */
function passkeysOf(tenant: ResolvedTenant) {
  return {
    rpId: rpIdOf(tenant),
    rpName: tenant.name,
    // The slug host's own origin; each verified custom domain is a related
    // origin (WebAuthn Related Origins, ADR-0036), on another host than the
    // rpId. `/.well-known/webauthn` serves the same list (`relatedOriginsOf`).
    origins: [originOf(tenant)] as [string],
    relatedOrigins: tenant.relatedOrigins,
    verifier: simpleWebAuthnVerifier(),
    firstFactor: true as const,
    userVerification: "required" as const,
  };
}

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
    // A passkey as the first factor (`passkeysOf`).
    passkeys: passkeysOf(tenant),
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
type TenantUser = NonNullable<Awaited<ReturnType<BuiltJanus["findUser"]>>>;
export type TenantJanus = BuiltJanus &
  StepUpPasskeyApi<TenantUser> &
  PasskeySignInApi<TenantUser>;

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

export function buildTenantJanus(
  db: Db,
  tenant: ResolvedTenant,
  log: (message: string) => void,
  secrets?: SecretBox,
  hooks?: InvitationHooks,
  events?: UserEventListener,
  // Specs only: the server always passes the keyring's (`createTenantJanusIssuers`).
  secondFactorKeys: [SealingKey, ...SealingKey[]] = ephemeralSecondFactorKeys(),
  connections?: ConnectionsOf,
): TenantJanus {
  const { config, realms } = socialConfigOf(tenant, secrets, log, connections);
  // Traced (D24): a span per flow, the security events as logs; neither names an address or a login.
  const instance = instrumentJanus(
    buildJanus(db, tenant, secondFactorKeys, config, hooks, events),
  );
  if (realms !== undefined) rememberRealms(instance, realms);
  // janus answers `stepUp.request(user, { via: "passkey" })` and `confirmPasskey`
  // for an instance with passkeys and a second factor (both wired above), but
  // its inferred type leaves them out: `StepUpPasskeyApi` names them, and the
  // guard checks them at runtime instead of casting. The same holds for
  // `secondFactor.confirmPasskey` and `secondFactor.passkeyOptions` (janus 0.80).
  if (!hasPasskeyStepUp(instance)) {
    throw new Error("janus: the step-up by passkey is not wired");
  }
  return instance;
}

function hasPasskeyStepUp(instance: BuiltJanus): instance is TenantJanus {
  const { stepUp, secondFactor } = instance as {
    stepUp: Partial<Record<string, unknown>>;
    secondFactor: Partial<Record<string, unknown>>;
  };
  return (
    typeof stepUp["confirmPasskey"] === "function" &&
    typeof stepUp["request"] === "function" &&
    typeof secondFactor["confirmPasskey"] === "function" &&
    typeof secondFactor["passkeyOptions"] === "function"
  );
}

/** The instance when the tenant has at least one social provider, else `null`. */
export const socialOf = (auth: TenantJanus): TenantSocialJanus | null =>
  "social" in auth && auth.social !== undefined
    ? (auth as TenantSocialJanus)
    : null;
