import type { Passkey } from "@softistx/janus";
import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import type { TenantJanus } from "@/users/tenant-janus";

/** Every refusal of a passkey sign-in alike: it must not tell whether the credential, the user or the tenant exists. */
export const passkeyInvalid = () =>
  new GraphQLError("The passkey was refused", {
    extensions: { code: "PASSKEY_INVALID", http: { status: 401 } },
  });

/** What the browser answered, from the JSON text the page sent. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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

/** The session of the request, or UNAUTHENTICATED (401). */
export async function currentOf(auth: TenantJanus, request: Request) {
  const current = await auth.authenticate(request);
  if (current === null) throw denial("UNAUTHENTICATED");
  return current;
}

/** The response a registration sends: text the verifier produced is not parsed here. */
export function responseOf(text: string): unknown {
  const value = parsed(text);
  if (value === undefined) {
    throw new GraphQLError("response must be a JSON string", {
      extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
    });
  }
  return value;
}

export const passkeyOut = (passkey: Passkey) => ({
  id: passkey.credentialId,
  name: passkey.name,
  transports: [...passkey.transports],
  backupEligible: passkey.backupEligible,
  backedUp: passkey.backedUp,
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt ?? null,
});
