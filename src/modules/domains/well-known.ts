/** The path browsers read to learn which origins may use a relying party's passkeys. */
export const WEBAUTHN_WELL_KNOWN = "/.well-known/webauthn";

/**
 * WebAuthn Related Origins (ADR-0036): the slug host (the rpId) lists the
 * origins of the tenant's verified custom domains. `hosts` are the verified
 * hosts; the scheme and port follow the issuer's.
 */
export function relatedOrigins(
  hosts: readonly string[],
  origin: { scheme: string; port?: number | undefined },
): Response {
  const suffix = origin.port === undefined ? "" : `:${origin.port}`;
  return Response.json(
    { origins: hosts.map((host) => `${origin.scheme}://${host}${suffix}`) },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
