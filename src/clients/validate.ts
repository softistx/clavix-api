import {
  DEVICE_GRANT,
  redirectUriProblem,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import { CliInputError } from "@/cli/errors";
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

export function validate(input: RegisterClientInput): {
  name: string;
  clientId: string;
  redirectUris: string[];
  grantTypes: OfferedGrant[] | undefined;
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
    !input.grants.includes(TOKEN_EXCHANGE_GRANT)
  ) {
    throw new CliInputError(
      `--grants must include authorization_code, ${DEVICE_GRANT} or ${TOKEN_EXCHANGE_GRANT}: a client with only refresh_token has no way to get a first token (add refresh_token beside it for a client that refreshes)`,
    );
  }
  const grantTypes =
    input.grants === undefined
      ? undefined
      : OFFERED_GRANTS.filter((grant) => input.grants?.includes(grant));
  return { name, clientId, redirectUris, grantTypes };
}
