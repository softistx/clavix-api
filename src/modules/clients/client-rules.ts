import { CatalogError } from "@/modules/resources/catalog.errors";
import type { ClientView } from "./client-listing";

/** The size limits and the "same client" test of the clients service. */
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
export function sameClient(
  stored: ClientView,
  input: {
    name: string;
    type: "public" | "confidential";
    redirectUris: readonly string[];
    requirePar?: boolean | undefined;
    dpopBound?: boolean | undefined;
    detailTypes?: readonly string[] | undefined;
    grants?: readonly string[] | undefined;
    allowedScopes?: readonly string[] | undefined;
    defaultScopes?: readonly string[] | undefined;
  },
) {
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
