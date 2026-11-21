import { badInput, refusal } from "./sign-in-methods.errors";
import {
  hasSignInMethod,
  isAvailable,
  type MethodEntry,
  type MethodType,
  type MfaPolicy,
  methodsOf,
  type SignInPolicy,
  type SocialEntry,
} from "./sign-in-methods.schema";
import {
  type SecretBox,
  type SecretResealCounts,
  secretContext,
} from "./sign-in-methods.secrets";
import type { CheckedSocial, SocialInput } from "./sign-in-methods.types";

/** The longest client id or secret a tenant gives. */
export const MAX_VALUE_LENGTH = 512;

/** The methods that need no outside provider. */
export const FIRST_PARTY: readonly MethodType[] = ["passkey", "emailCode"];

/** A client id or secret trimmed, 1 to 512 characters; `BAD_USER_INPUT` otherwise. */
export function checkedValue(name: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_VALUE_LENGTH) {
    throw badInput(`${name} must be 1 to ${MAX_VALUE_LENGTH} characters`);
  }
  return trimmed;
}

/** The strings of a social change checked, a value left out staying `undefined`. */
export function checkedSocial(input: SocialInput): CheckedSocial {
  return {
    clientId:
      input.clientId === undefined
        ? undefined
        : checkedValue("clientId", input.clientId),
    clientSecret:
      input.clientSecret === undefined
        ? undefined
        : checkedValue("clientSecret", input.clientSecret),
  };
}

/**
 * The change an update of the methods asks for, by type. A type given twice is
 * `BAD_USER_INPUT`; turning on a method that is not available yet is
 * `SIGN_IN_METHOD_UNAVAILABLE` (409).
 */
export function methodChange(
  entries: readonly MethodEntry[],
): Map<MethodType, boolean> {
  const change = new Map(entries.map(({ type, enabled }) => [type, enabled]));
  if (change.size !== entries.length) {
    throw badInput("A sign-in method is given twice");
  }
  for (const { type, enabled } of entries) {
    if (enabled && !isAvailable(type)) {
      throw refusal(
        "SIGN_IN_METHOD_UNAVAILABLE",
        `Sign-in by ${type} is not available yet`,
        409,
      );
    }
  }
  return change;
}

/** The policy's methods with the change applied; a type with no entry keeps its value. */
export function withMethods(
  policy: SignInPolicy,
  change: ReadonlyMap<MethodType, boolean>,
): MethodEntry[] {
  return methodsOf(policy).map(({ type, enabled }) => ({
    type,
    enabled: change.get(type) ?? enabled,
  }));
}

/** The multi-factor policy after an update; a field left out keeps its value. */
export const nextMfa = (
  current: MfaPolicy,
  input: Partial<MfaPolicy>,
): MfaPolicy => ({
  mode: input.mode ?? current.mode,
  totp: input.totp ?? current.totp,
});

/**
 * The platform tenant signs the console's operators in, so it always keeps
 * a first-party method (passkey or e-mail code), whatever social providers
 * it has: those depend on an outside provider.
 */
export function requireFirstParty(policy: SignInPolicy): void {
  const methods = methodsOf(policy);
  if (!methods.some((m) => m.enabled && FIRST_PARTY.includes(m.type))) {
    throw refusal(
      "PLATFORM_FIRST_PARTY_METHOD",
      "The platform tenant must keep passkey or e-mail code sign-in enabled",
      409,
    );
  }
}

/** A tenant keeps at least one way for its users to sign in. */
export function requireUsable(policy: SignInPolicy): SignInPolicy {
  if (!hasSignInMethod(policy)) {
    throw refusal(
      "NO_SIGN_IN_METHOD",
      "At least one sign-in method must stay enabled",
      409,
    );
  }
  return policy;
}

/**
 * The social entries sealed again under the box's first key, and how many
 * were: an entry already under it is left as it is, one no key opens too
 * (counted `unreadable` and logged by provider and tenant, never by value).
 */
export function resealEntries(
  owner: string,
  social: readonly SocialEntry[],
  box: SecretBox,
  log: (message: string) => void,
  counts: SecretResealCounts,
): { social: SocialEntry[]; pending: number } {
  let pending = 0;
  const sealed = social.map((entry) => {
    counts.scanned += 1;
    if (entry.secret.kid === box.kid) {
      counts.current += 1;
      return entry;
    }
    try {
      const secret = box.reseal(
        entry.secret,
        secretContext(owner, entry.provider),
      );
      pending += 1;
      return { ...entry, secret };
    } catch {
      counts.unreadable += 1;
      log(
        `sign-in: the ${entry.provider} secret of tenant ${owner} could not be sealed again`,
      );
      return entry;
    }
  });
  return { social: sealed, pending };
}
