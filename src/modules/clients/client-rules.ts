import { CatalogError } from "@/modules/resources/catalog.errors";
import type { ClientView } from "./client-listing";

/** The size limits and the "same client" test of the clients service. */
const MAX_NAME = 100;
const MAX_REDIRECT_URIS = 20;
export const MAX_QUERY = 100;
export const MAX_CURSOR = 200;

export function checkSizes(input: {
  name?: string | undefined;
  redirectUris?: readonly string[] | undefined;
}) {
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

/** The stored client has the input's name, type and redirect URIs. */
export function sameClient(
  stored: ClientView,
  input: {
    name: string;
    type: "public" | "confidential";
    redirectUris: readonly string[];
    requirePar?: boolean | undefined;
    dpopBound?: boolean | undefined;
    grants?: readonly string[] | undefined;
  },
) {
  const wanted = new Set(input.redirectUris);
  const wantedGrants = new Set(input.grants);
  return (
    (input.grants === undefined ||
      (stored.grantTypes.length === wantedGrants.size &&
        stored.grantTypes.every((grant) => wantedGrants.has(grant)))) &&
    stored.name === input.name.trim() &&
    stored.type === input.type &&
    (input.requirePar === undefined ||
      input.requirePar === stored.requirePushedAuthorizationRequests) &&
    (input.dpopBound === undefined ||
      input.dpopBound === stored.dpopBoundAccessTokens) &&
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
