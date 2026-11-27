import { type ProfileChanges, patchOf } from "@/modules/profile";
import type { TenantJanus } from "@/modules/users";
import {
  isAvailable,
  type MethodType,
  type MfaMode,
  methodsOf,
  type SignInPolicy,
  type SocialEntry,
  type SocialProviderId,
} from "./sign-in-methods.schema";
import { type SecretBox, secretContext } from "./sign-in-methods.secrets";
import { callbackUrlOf } from "./sign-in-methods.social";

/** Whether two values serialise alike (the policy's plain data, in the same key order). */
export const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Whether the stored entry already holds this secret (an unopenable one holds nothing). */
export function holdsSecret(
  box: SecretBox,
  tenantId: string,
  current: SocialEntry | undefined,
  secret: string,
): boolean {
  if (current === undefined) return false;
  try {
    return (
      box.open(current.secret, secretContext(tenantId, current.provider)) ===
      secret
    );
  } catch {
    return false;
  }
}

/** The entries with `entry` in place of its provider's, ordered by provider. */
export function withSocial(
  social: readonly SocialEntry[],
  entry: SocialEntry,
): SocialEntry[] {
  return [...social.filter((e) => e.provider !== entry.provider), entry].sort(
    (a, b) => a.provider.localeCompare(b.provider),
  );
}

/** The console's enum name of each MFA mode, method and social provider. */
export const CONSOLE_MODE = {
  passkeySufficient: "PASSKEY_SUFFICIENT",
  required: "REQUIRED",
} as const satisfies Record<MfaMode, string>;

export const CONSOLE_METHOD = {
  passkey: "PASSKEY",
  emailCode: "EMAIL_CODE",
  magicLink: "MAGIC_LINK",
  password: "PASSWORD",
} as const satisfies Record<MethodType, string>;

export const CONSOLE_KIND = {
  google: "GOOGLE",
  github: "GITHUB",
  microsoft: "MICROSOFT",
} as const satisfies Record<SocialProviderId, string>;

/**
 * The stored name of a GraphQL enum value (`EMAIL_CODE` to `emailCode`). The
 * schema already limits the value to the enum, so a miss is a mismatch between
 * the SDL and the map: it fails loudly instead of storing `undefined`.
 */
export const storedOf = <K extends string, V extends string>(
  names: Record<K, V>,
  value: V,
): K => {
  for (const key in names) {
    if (names[key] === value) return key;
  }
  throw new Error(`No stored name for the enum value "${String(value)}"`);
};

/** The policy as the console shows it: no secret, only that one is stored. */
export const policyShape = (
  tenant: {
    _id: { toHexString(): string };
    signIn: SignInPolicy;
    version: number;
  },
  issuer: string,
) => ({
  tenantId: tenant._id.toHexString(),
  methods: methodsOf(tenant.signIn).map(({ type, enabled }) => ({
    type: CONSOLE_METHOD[type],
    enabled,
    available: isAvailable(type),
  })),
  social: tenant.signIn.social.map((entry) => ({
    provider: CONSOLE_KIND[entry.provider],
    clientId: entry.clientId,
    hasSecret: true,
    enabled: entry.enabled,
    callbackUrl: callbackUrlOf(issuer, entry.provider),
  })),
  mfa: {
    mode: CONSOLE_MODE[tenant.signIn.mfa.mode],
    totp: tenant.signIn.mfa.totp,
  },
  version: tenant.version,
});

/** The standard profile fields the previous holder of an address leaves behind: the new owner starts with none (`name` is required and stays, the picture goes through the avatar removal). */
const CLEARED: ProfileChanges = {
  givenName: null,
  familyName: null,
  nickname: null,
  phone: null,
  birthdate: null,
  address: null,
};

/** Clears the previous holder's names, phone, birthdate and address on the user; a repeat writes nothing. */
export async function clearReplacedProfile(
  auth: Pick<TenantJanus, "findUser" | "update">,
  userId: string,
): Promise<void> {
  const user = await auth.findUser(userId);
  if (user === null) return;
  const patch = patchOf(CLEARED, user);
  if (Object.keys(patch).length === 0) return;
  await auth.update(user, patch, { ifVersion: user.version });
}

/** What a replaced holder leaves on the user, as steps the caller binds. */
export interface ReplacedSteps {
  /** The previous holder's OAuth grants and refresh tokens (queued for a retry by the caller when it fails). */
  readonly revoke: () => Promise<unknown>;
  /** Their attribute values and picture: queued for a retry, or erased now without a queue. */
  readonly erase: () => Promise<unknown>;
  /** Their standard profile fields. */
  readonly clearProfile: () => Promise<unknown>;
}

/**
 * Runs what a replacement leaves to clean, janus never repeating `replaced`.
 * The revocation is first, then the erase; both are fatal, and every step runs
 * whatever the one before did: the first failure is thrown once the rest ran.
 * The profile clearing is best effort, caught and reported.
 */
export async function settleReplaced(
  steps: ReplacedSteps,
  report: (message: string, cause: unknown) => void,
): Promise<void> {
  let failure: { cause: unknown } | null = null;
  for (const step of [steps.revoke, steps.erase]) {
    try {
      await step();
    } catch (cause) {
      failure ??= { cause };
    }
  }
  try {
    await steps.clearProfile();
  } catch (cause) {
    report(
      "sign-in: the replaced holder's profile fields were not cleared",
      cause,
    );
  }
  if (failure !== null) throw failure.cause;
}
