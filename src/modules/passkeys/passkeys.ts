import { JanusError, type Passkey } from "@softistx/janus";
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

/** The passkey sign-in: any janus refusal is `PASSKEY_INVALID`; a store failure stays a 503. */
export async function signInWithPasskey(
  auth: TenantJanus,
  challenge: string,
  response: string,
) {
  try {
    return await auth.passkeys.signIn(challenge, parsed(response));
  } catch (error) {
    // Temporary, until the verifier maps every response error to a refusal: a
    // verifier throw on a known credential must not differ from an unknown one.
    if (error instanceof JanusError && error.code === "STORE_FAILED")
      throw error;
    throw passkeyInvalid();
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
