import { GraphQLError } from "graphql";
import { defineCodes } from "@/i18n/define-codes";
import { fail } from "@/shared/errors";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("passkeys", [
  "PASSKEY_INVALID",
  "PASSKEY_THROTTLED",
]);

/** Every refusal of a passkey sign-in alike: it must not tell whether the credential, the user or the tenant exists. */
export const passkeyInvalid = () =>
  fail("PASSKEY_INVALID", "The passkey was refused", { status: 401 });

/** `PASSKEY_THROTTLED`, 429 with `Retry-After` (seconds). */
export const passkeyThrottled = (retryAfter: number) =>
  fail("PASSKEY_THROTTLED", "Too many passkey sign-ins requested", {
    status: 429,
    headers: { "retry-after": String(retryAfter) },
  });

/** The codes janus answers a passkey sign-in it refuses with: a bad assertion, a challenge that is unknown, spent or lapsed, or a user who may not sign in. */
const REFUSALS = new Set([
  "CREDENTIALS_INVALID",
  "TOKEN_UNKNOWN",
  "TOKEN_SPENT",
  "TOKEN_EXPIRED",
  "BAD_USER_INPUT",
  "USER_INACTIVE",
  "EMAIL_UNVERIFIED",
]);

/** janus's passkey sign-in, with every refusal answered as the one `PASSKEY_INVALID` this API has always given; a store failure stays a 503. */
export async function asPasskeyInvalid<T>(signIn: () => Promise<T>) {
  try {
    return await signIn();
  } catch (error) {
    const code = (error as { extensions?: { code?: unknown } }).extensions
      ?.code;
    if (error instanceof GraphQLError && REFUSALS.has(String(code))) {
      throw passkeyInvalid();
    }
    throw error;
  }
}
