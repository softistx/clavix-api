import {
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_GRANT,
  redirectUriProblem,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import { CliInputError } from "@/shared/cli";
import { OFFERED_GRANTS, type OfferedGrant } from "./grants";
import type { RegisterClientInput } from "./register-client";

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The default client id of a name: lowercase `a-z0-9-`. */
export const clientIdOf = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

/** A scope list (deduplicated, in order) of non-empty tokens with no space; `undefined` when not given. */
function scopeList(
  label: string,
  scopes: readonly string[] | undefined,
): string[] | undefined {
  if (scopes === undefined) return undefined;
  const clean = [...new Set(scopes.map((scope) => scope.trim()))];
  for (const scope of clean) {
    if (scope === "" || /\s/.test(scope)) {
      throw new CliInputError(
        `${label}: "${scope}" is not a scope (a non-empty token with no space)`,
      );
    }
  }
  return clean;
}

export function validate(input: RegisterClientInput): {
  name: string;
  clientId: string;
  redirectUris: string[];
  grantTypes: OfferedGrant[] | undefined;
  allowedScopes: string[] | undefined;
  defaultScopes: string[] | undefined;
} {
  const name = input.name.trim();
  if (name === "") throw new CliInputError("a client needs a name");
  const clientId = input.clientId ?? clientIdOf(name);
  if (!ID_PATTERN.test(clientId)) {
    throw new CliInputError(
      `client id "${clientId}" must be 1-64 characters of a-z, 0-9 and "-", not starting or ending with "-"`,
    );
  }
  const redirectUris = [...new Set(input.redirectUris)];
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem !== null) {
      throw new CliInputError(`redirect URI "${uri}": ${problem}`);
    }
  }
  if (input.grants?.length === 0) {
    throw new CliInputError("--grants needs at least one grant type");
  }
  for (const grant of input.grants ?? []) {
    if (!(OFFERED_GRANTS as readonly string[]).includes(grant)) {
      throw new CliInputError(
        `grant "${grant}" is not offered: Clavix offers ${OFFERED_GRANTS.join(", ")}`,
      );
    }
  }
  if (
    input.grants !== undefined &&
    !input.grants.includes("authorization_code") &&
    !input.grants.includes(DEVICE_GRANT) &&
    !input.grants.includes(TOKEN_EXCHANGE_GRANT) &&
    !input.grants.includes(CLIENT_CREDENTIALS_GRANT)
  ) {
    throw new CliInputError(
      `--grants must include authorization_code, ${DEVICE_GRANT}, ${TOKEN_EXCHANGE_GRANT} or ${CLIENT_CREDENTIALS_GRANT}: a client with only refresh_token has no way to get a first token (add refresh_token beside it for a client that refreshes)`,
    );
  }
  const grantTypes =
    input.grants === undefined
      ? undefined
      : OFFERED_GRANTS.filter((grant) => input.grants?.includes(grant));
  const allowedScopes = scopeList("allowed scopes", input.allowedScopes);
  const defaultScopes = scopeList("default scopes", input.defaultScopes);
  return {
    name,
    clientId,
    redirectUris,
    grantTypes,
    allowedScopes,
    defaultScopes,
  };
}
