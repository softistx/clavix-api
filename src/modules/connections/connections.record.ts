import { checkConnection, type OidcConnection } from "@softistx/janus-social";
import { ConnectionError } from "./connections.errors";
import type { ConnectionDoc } from "./connections.model";

/** The provider names the static presets own: a connection never takes one. */
export const RESERVED_CONNECTION_IDS = ["google", "github", "microsoft"];

/** A domain that always passes `checkConnection`, standing in while a connection has none yet. */
const PLACEHOLDER_DOMAIN = "placeholder.example.com";

/** What `checkConnection` is given: janus's record, the secret in clear. */
export interface RecordParts {
  connectionId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  clientAuthentication: "post" | "basic" | null;
  idTokenSignedResponseAlg: string | null;
  scopes: readonly string[] | null;
  emailTrust: string;
  claims: Record<string, string | undefined>;
  domains: readonly string[];
  revision: number;
}

/**
 * Validates and normalises through janus's `checkConnection`, whose
 * `TypeError` ("checkConnection: ...") names fields, never values: it becomes
 * a `BAD_USER_INPUT`. An empty domain list is validated with a placeholder
 * (a connection gets its domains after it exists) and returned empty.
 */
export function checked(parts: RecordParts): OidcConnection {
  if (RESERVED_CONNECTION_IDS.includes(parts.connectionId)) {
    throw new ConnectionError(
      "BAD_USER_INPUT",
      `"${parts.connectionId}" is a built-in provider name`,
      "id",
    );
  }
  const claims = Object.fromEntries(
    Object.entries(parts.claims).filter(([, value]) => value !== undefined),
  );
  const record = {
    id: parts.connectionId,
    issuer: parts.issuer,
    client: {
      id: parts.clientId,
      secret: parts.clientSecret,
      ...(parts.clientAuthentication === null
        ? {}
        : { authentication: parts.clientAuthentication }),
      ...(parts.idTokenSignedResponseAlg === null
        ? {}
        : { idTokenSignedResponseAlg: parts.idTokenSignedResponseAlg }),
    },
    ...(parts.scopes === null ? {} : { scopes: [...parts.scopes] }),
    domains: parts.domains.length === 0 ? [PLACEHOLDER_DOMAIN] : parts.domains,
    emailTrust: parts.emailTrust,
    ...(Object.keys(claims).length === 0 ? {} : { claims }),
    revision: parts.revision,
  };
  try {
    const result = checkConnection(record);
    return parts.domains.length === 0 ? { ...result, domains: [] } : result;
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message.startsWith("checkConnection:")
    ) {
      throw new ConnectionError("BAD_USER_INPUT", error.message);
    }
    throw error;
  }
}

/** The stored parts of a document, with the secret opened by the caller. */
export const partsOf = (
  doc: ConnectionDoc,
  clientSecret: string,
  domains: readonly string[],
): RecordParts => ({
  connectionId: doc.connectionId,
  issuer: doc.issuer,
  clientId: doc.clientId,
  clientSecret,
  clientAuthentication: doc.clientAuthentication,
  idTokenSignedResponseAlg: doc.idTokenSignedResponseAlg,
  scopes: doc.scopes,
  emailTrust: doc.emailTrust,
  claims: doc.claims,
  domains,
  revision: doc.revision,
});
