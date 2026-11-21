import {
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_GRANT,
  type OAuthClientRecord,
  redirectUriProblem,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import { CliInputError } from "@/shared/cli";
import { isOneOf, unique } from "@/shared/values";
import { clientIdOf, OFFERED_GRANTS, usesRedirect } from "./clients.rules";
import type { OfferedGrant, RegisterClientInput } from "./clients.types";

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A scope list (deduplicated, in order) of non-empty tokens with no space; `undefined` when not given. */
function scopeList(
  label: string,
  scopes: readonly string[] | undefined,
): string[] | undefined {
  if (scopes === undefined) return undefined;
  const clean = unique(scopes.map((scope) => scope.trim()));
  for (const scope of clean) {
    if (scope === "" || /\s/.test(scope)) {
      throw new CliInputError(
        `${label}: "${scope}" is not a scope (a non-empty token with no space)`,
      );
    }
  }
  return clean;
}

/** The grants a registration asks for: each offered, one of them a way to a first token; `undefined` when none asked. */
function grantsAsked(
  grants: readonly string[] | undefined,
): OfferedGrant[] | undefined {
  if (grants?.length === 0) {
    throw new CliInputError("--grants needs at least one grant type");
  }
  for (const grant of grants ?? []) {
    if (!isOneOf(OFFERED_GRANTS, grant)) {
      throw new CliInputError(
        `grant "${grant}" is not offered: Clavix offers ${OFFERED_GRANTS.join(", ")}`,
      );
    }
  }
  if (
    grants !== undefined &&
    !grants.includes("authorization_code") &&
    !grants.includes(DEVICE_GRANT) &&
    !grants.includes(TOKEN_EXCHANGE_GRANT) &&
    !grants.includes(CLIENT_CREDENTIALS_GRANT)
  ) {
    throw new CliInputError(
      `--grants must include authorization_code, ${DEVICE_GRANT}, ${TOKEN_EXCHANGE_GRANT} or ${CLIENT_CREDENTIALS_GRANT}: a client with only refresh_token has no way to get a first token (add refresh_token beside it for a client that refreshes)`,
    );
  }
  return grants === undefined
    ? undefined
    : OFFERED_GRANTS.filter((grant) => grants.includes(grant));
}

/** The input of a registration, checked and cleaned (no store read). */
export function validate(input: RegisterClientInput) {
  const name = input.name.trim();
  if (name === "") throw new CliInputError("a client needs a name");
  const clientId = input.clientId ?? clientIdOf(name);
  if (!ID_PATTERN.test(clientId)) {
    throw new CliInputError(
      `client id "${clientId}" must be 1-64 characters of a-z, 0-9 and "-", not starting or ending with "-"`,
    );
  }
  const redirectUris = unique(input.redirectUris);
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem !== null) {
      throw new CliInputError(`redirect URI "${uri}": ${problem}`);
    }
  }
  return {
    name,
    clientId,
    redirectUris,
    grantTypes: grantsAsked(input.grants),
    allowedScopes: scopeList("allowed scopes", input.allowedScopes),
    defaultScopes: scopeList("default scopes", input.defaultScopes),
  };
}

type Checked = ReturnType<typeof validate>;

/**
 * The checks that need the stored client: the redirect URI, the type and the
 * grants it may have. Returns whether the client has the client credentials
 * grant. Judged on the grants the client will have: the input's, else the
 * stored ones (a re-run of a device-only client without --grants keeps them).
 */
export function checkGrants(
  checked: Checked,
  confidential: boolean,
  existing: OAuthClientRecord | null,
): boolean {
  const { clientId, redirectUris } = checked;
  const grants = checked.grantTypes ?? existing?.grantTypes;
  if (redirectUris.length === 0 && usesRedirect(grants)) {
    throw new CliInputError(
      "a client needs at least one redirect URI (a device-only, token-exchange-only or client-credentials-only client, --grants without authorization_code, needs none)",
    );
  }
  if (!confidential && grants?.includes(TOKEN_EXCHANGE_GRANT) === true) {
    throw new CliInputError(
      `the token exchange grant needs a confidential client (--confidential): "${clientId}" is not one`,
    );
  }
  const machineGrant = grants?.includes(CLIENT_CREDENTIALS_GRANT) === true;
  if (!confidential && machineGrant) {
    throw new CliInputError(
      `the client credentials grant needs a confidential client (--confidential): "${clientId}" is not one`,
    );
  }
  return machineGrant;
}

/**
 * The client credentials scopes the client will have. Only a client with the
 * grant has scopes for it; without it they are dropped (and asking for some is
 * refused). A client with the grant needs a ceiling, and its defaults sit in it.
 */
export function machineScopesOf(
  checked: Checked,
  machineGrant: boolean,
  existing: OAuthClientRecord | null,
): { allowed: string[]; default: string[] } {
  const { clientId, allowedScopes, defaultScopes } = checked;
  if (!machineGrant) {
    if ((allowedScopes?.length ?? 0) > 0 || (defaultScopes?.length ?? 0) > 0) {
      throw new CliInputError(
        `--allowed-scopes and --default-scopes belong to the ${CLIENT_CREDENTIALS_GRANT} grant, which "${clientId}" does not list`,
      );
    }
    return { allowed: [], default: [] };
  }
  const allowed = allowedScopes ?? existing?.allowedScopes ?? [];
  const defaults = defaultScopes ?? existing?.defaultScopes ?? [];
  if (allowed.length === 0) {
    throw new CliInputError(
      `the client credentials grant needs at least one allowed scope (--allowed-scopes): without one, every token request is invalid_scope`,
    );
  }
  const outside = defaults.filter((scope) => !allowed.includes(scope));
  if (outside.length > 0) {
    throw new CliInputError(
      `default scopes must be allowed scopes: ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not`,
    );
  }
  return { allowed: [...allowed], default: [...defaults] };
}

/** A client keeps its type: public stays public, confidential stays confidential, and only a confidential one has a secret to rotate. */
export function checkType(
  clientId: string,
  confidential: boolean,
  existing: OAuthClientRecord | null,
  rotate: boolean,
): void {
  const hasSecret = existing?.secretHash !== undefined;
  if (!confidential && hasSecret) {
    throw new CliInputError(
      `"${clientId}" is a confidential client: re-run with --confidential, or use another client id (a client keeps its type)`,
    );
  }
  if (confidential && existing !== null && !hasSecret) {
    throw new CliInputError(
      `"${clientId}" is a public client: it cannot become confidential (a client keeps its type); register a confidential client under another client id`,
    );
  }
  if (!confidential && rotate) {
    throw new CliInputError(
      `--rotate-secret needs a confidential client: "${clientId}" is public and has no secret`,
    );
  }
}
