import {
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_GRANT,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import { CatalogError } from "@/modules/resources";
import type {
  ClientView,
  CreateClientInput,
  OfferedGrant,
} from "./clients.types";

// The size limits and the "same client" test of the clients service.
const MAX_NAME = 100;
const MAX_REDIRECT_URIS = 20;
const MAX_DETAIL_TYPES = 50;
const MAX_SCOPES = 100;
export const MAX_QUERY = 100;
export const MAX_CURSOR = 200;

export function checkSizes(input: {
  name?: string | undefined;
  redirectUris?: readonly string[] | undefined;
  detailTypes?: readonly string[] | undefined;
  allowedScopes?: readonly string[] | undefined;
  defaultScopes?: readonly string[] | undefined;
}) {
  if (
    (input.allowedScopes?.length ?? 0) > MAX_SCOPES ||
    (input.defaultScopes?.length ?? 0) > MAX_SCOPES
  ) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `a client lists at most ${MAX_SCOPES} allowed scopes and ${MAX_SCOPES} default scopes`,
    );
  }
  if ((input.detailTypes?.length ?? 0) > MAX_DETAIL_TYPES) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `a client lists at most ${MAX_DETAIL_TYPES} detail types`,
    );
  }
  if ((input.name?.length ?? 0) > MAX_NAME) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `a client's name has at most ${MAX_NAME} characters`,
    );
  }
  if ((input.redirectUris?.length ?? 0) > MAX_REDIRECT_URIS) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `a client has at most ${MAX_REDIRECT_URIS} redirect URIs`,
    );
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
};

/** The stored client has the input's name, type and redirect URIs. */
export function sameClient(stored: ClientView, input: CreateClientInput) {
  const wanted = new Set(input.redirectUris);
  const wantedGrants = new Set(input.grants);
  return (
    (input.grants === undefined ||
      (stored.grantTypes.length === wantedGrants.size &&
        stored.grantTypes.every((grant) => wantedGrants.has(grant)))) &&
    (input.allowedScopes === undefined ||
      sameSet(
        stored.allowedScopes,
        input.allowedScopes.map((s) => s.trim()),
      )) &&
    (input.defaultScopes === undefined ||
      sameSet(
        stored.defaultScopes,
        input.defaultScopes.map((s) => s.trim()),
      )) &&
    stored.name === input.name.trim() &&
    stored.type === input.type &&
    (input.requirePar === undefined ||
      input.requirePar === stored.requirePushedAuthorizationRequests) &&
    (input.dpopBound === undefined ||
      input.dpopBound === stored.dpopBoundAccessTokens) &&
    (input.detailTypes === undefined ||
      sameSet(stored.authorizationDetailsTypes, input.detailTypes)) &&
    stored.redirectUris.length === wanted.size &&
    stored.redirectUris.every((uri) => wanted.has(uri))
  );
}

export function checkQuery(q: string | undefined) {
  if ((q?.length ?? 0) > MAX_QUERY) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `a search has at most ${MAX_QUERY} characters`,
    );
  }
}

/**
 * The grant types Clavix offers. A client's `grantTypes` is enforced by janus-oauth on
 * `/authorize`, the code exchange, the refresh grant and the device grant
 * (`unauthorized_client`), and an explicit list is taken as written: a client
 * that refreshes lists `refresh_token` beside `authorization_code` or the
 * device URN. A list needs `authorization_code` or the device grant
 * (`refresh_token` alone is refused by janus). The device grant is never
 * implied: a client opts in. The token exchange grant (RFC 8693) is the same,
 * for a confidential client only, and it also needs the client's rules
 * (`clientPolicies`): with none, every exchange is refused. The client
 * credentials grant (RFC 6749 section 4.4) is the same: a confidential
 * client only, never implied, with the scopes it may ask for
 * (`allowedScopes`), and served only for a resource that opted in
 * (`allowClientCredentials`).
 */
export const OFFERED_GRANTS = [
  "authorization_code",
  "refresh_token",
  DEVICE_GRANT,
  TOKEN_EXCHANGE_GRANT,
  CLIENT_CREDENTIALS_GRANT,
] as const satisfies readonly OfferedGrant[];

/** What a client with no recorded `grantTypes` may use (janus's default). */
export const DEFAULT_GRANTS = ["authorization_code", "refresh_token"] as const;

/** Whether a client with these grants goes through a browser redirect (it needs a redirect URI). */
export const usesRedirect = (grants: readonly string[] | undefined) =>
  grants === undefined || grants.includes("authorization_code");

/** The default client id of a name: lowercase `a-z0-9-`. */
export const clientIdOf = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
