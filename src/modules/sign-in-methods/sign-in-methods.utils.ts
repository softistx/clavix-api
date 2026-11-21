import type { SocialEntry } from "./sign-in-methods.schema";
import { type SecretBox, secretContext } from "./sign-in-methods.secrets";

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
