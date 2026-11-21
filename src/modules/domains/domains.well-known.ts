/** The path browsers read to learn which origins may use a relying party's passkeys. */
export const WEBAUTHN_WELL_KNOWN = "/.well-known/webauthn";

/**
 * WebAuthn Related Origins (ADR-0036): the slug host (the rpId) lists the
 * origins of the tenant's verified custom domains. `hosts` are the verified
 * hosts; the scheme and port follow the issuer's.
 */
export function relatedOrigins(
  hosts: readonly string[],
  origin: PublicSchemePort,
): Response {
  return Response.json(
    { origins: relatedOriginsOf(hosts, origin) },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

interface PublicSchemePort {
  scheme: string;
  port?: number | undefined;
}

/**
 * The origins of verified custom-domain hosts. The one list both the
 * `/.well-known/webauthn` document serves and the passkey layer accepts
 * (`origins` of janus-passkeys is exact), so the two cannot drift.
 */
export function relatedOriginsOf(
  hosts: readonly string[],
  origin: PublicSchemePort,
): string[] {
  const suffix = origin.port === undefined ? "" : `:${origin.port}`;
  return hosts.map((host) => `${origin.scheme}://${host}${suffix}`);
}
