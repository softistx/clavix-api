import type {
  PasskeySignInApi,
  SealingKey,
  StepUpPasskeyApi,
  UserEventListener,
} from "@softistx/janus";
import type { SocialAuth } from "@softistx/janus-graphql";
import { instrumentJanus } from "@softistx/janus-telemetry";
import type { Db } from "mongodb";
import type { SecretBox } from "@/modules/sign-in-methods";
import { isRecord } from "@/shared/values";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { buildJanus, type InvitationHooks } from "./users.janus-config";
import { type ConnectionsOf, socialConfigOf } from "./users.social";
import { rememberRealms } from "./users.sso";

export type { InvitationHooks, InvitationHooksFor } from "./users.janus-config";

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
  secrets: SecretBox,
  hooks: InvitationHooks,
  events: UserEventListener,
  secondFactorKeys: [SealingKey, ...SealingKey[]],
  connections: ConnectionsOf,
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
  const stepUp: unknown = instance.stepUp;
  const secondFactor: unknown = instance.secondFactor;
  return (
    isRecord(stepUp) &&
    isRecord(secondFactor) &&
    typeof stepUp["confirmPasskey"] === "function" &&
    typeof stepUp["request"] === "function" &&
    typeof secondFactor["confirmPasskey"] === "function" &&
    typeof secondFactor["passkeyOptions"] === "function"
  );
}

/** The instance when the tenant has at least one social provider, else `null`. */
export const socialOf = (auth: TenantJanus): TenantSocialJanus | null =>
  hasSocial(auth) ? auth : null;

function hasSocial(auth: TenantJanus): auth is TenantSocialJanus {
  return (
    "social" in auth &&
    isRecord(auth.social) &&
    typeof auth.social["countLinks"] === "function"
  );
}
