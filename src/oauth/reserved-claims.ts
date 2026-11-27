/**
 * The claims without the names the server owns: an attribute claim never takes
 * the place of one of them (a catalogue refuses the names at creation; this
 * keeps a token valid whatever the data). The list is the token's own: the ID
 * token's for the OIDC provider, the access token's for the building parts.
 */
export const omitReserved = (
  reserved: ReadonlySet<string>,
  claims: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(claims).filter(([name]) => !reserved.has(name)),
  );
