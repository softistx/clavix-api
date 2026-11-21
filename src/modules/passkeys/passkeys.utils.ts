import type { Passkey } from "@softistx/janus";
import type { TenantJanus } from "@/modules/users";
import { badInput, fail } from "@/shared/errors";

/** The session of the request, or UNAUTHENTICATED (401). */
export async function currentOf(auth: TenantJanus, request: Request) {
  const current = await auth.authenticate(request);
  if (current === null)
    throw fail("UNAUTHENTICATED", "Not signed in", { status: 401 });
  return current;
}

/** The response a registration sends, from the JSON text the page sent: text the verifier produced is not parsed further here. */
export function responseOf(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (value === undefined) {
    throw badInput("response must be a JSON string");
  }
  return value;
}

/** The `Passkey` the API answers for a janus passkey. */
export const passkeyOut = (passkey: Passkey) => ({
  id: passkey.credentialId,
  name: passkey.name,
  transports: [...passkey.transports],
  backupEligible: passkey.backupEligible,
  backedUp: passkey.backedUp,
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt ?? null,
});

/** The options a passkey ceremony answers: JSON text for the browser, the challenge and its expiry. */
export const ceremonyOut = (issued: {
  options: unknown;
  challenge: string;
  expiresAt: Date;
}) => ({
  options: JSON.stringify(issued.options),
  challenge: issued.challenge,
  expiresAt: issued.expiresAt,
});
