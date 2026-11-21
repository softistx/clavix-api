import { parseArgs } from "node:util";
import { CliInputError } from "@/shared/cli";
import { OFFERED_GRANTS } from "./clients.rules";
import type { RegisterClientInput } from "./clients.types";

export const USAGE = `Usage: bun run clients:create --tenant <slug> --name <name> --redirect-uri <uri> [options]

  --tenant <slug>          the tenant the client is registered on (required)
  --name <name>            the client's name (required)
  --redirect-uri <uri>     an exact redirect URI; repeat for several (required, except for a device-only client)
  --confidential           a back end with a secret (client_secret_basic); default is a public client with PKCE
  --client-id <id>         the client's id in the tenant; default: the name as a-z0-9-. Re-running with the same id updates the client
  --grants <a,b>           ${OFFERED_GRANTS.join(",")} (enforced by janus: list refresh_token to let the client refresh; needs authorization_code, the device URN or the token-exchange URN or client_credentials, which are for a confidential client (token exchange also needs rules set in the console, client_credentials needs --allowed-scopes and a resource that opted in); default: kept, else authorization_code,refresh_token). A client without authorization_code needs no --redirect-uri
  --allowed-scopes <a,b>   the scopes the client may ask for with the client_credentials grant (required with it: the ceiling, a request is cut to them); replaces the list, kept on a re-run without the flag
  --default-scopes <a,b>   the scopes a client_credentials request with no scope gets, within --allowed-scopes
  --require-par            make the client push its authorization requests to /par (RFC 9126); kept on a re-run unless --no-require-par
  --no-require-par         stop requiring it of this client
  --dpop-bound             bind the client's tokens to a DPoP key (RFC 9449): its token requests must carry a proof; kept on a re-run unless --no-dpop-bound
  --no-dpop-bound          stop requiring it of this client
  --detail-types <a,b>     the authorization detail types (RFC 9396) the client may ask for: each is a type of the tenant, and the client must have --require-par (and the tenant's consent page must show them if the client uses /authorize or the device grant); replaces the list, an empty value (--detail-types=) clears it; kept on a re-run without the flag
  --rotate-secret          mint a new secret for an existing confidential client`;

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

/** The script's flags as a registration input; a `CliInputError` for a bad line. */
export function parseClientArgs(argv: readonly string[]): RegisterClientInput {
  let values: ReturnType<typeof read>["values"];
  try {
    values = read(argv).values;
  } catch (error) {
    throw new CliInputError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (values.tenant === undefined) {
    throw new CliInputError("--tenant is required");
  }
  if (values.name === undefined) throw new CliInputError("--name is required");
  return {
    tenant: values.tenant,
    name: values.name,
    redirectUris: values["redirect-uri"] ?? [],
    type: values.confidential === true ? "confidential" : "public",
    ...(values["client-id"] === undefined
      ? {}
      : { clientId: values["client-id"] }),
    ...(values.grants === undefined
      ? {}
      : { grants: values.grants.split(",").map((grant) => grant.trim()) }),
    ...(values["require-par"] === true
      ? { requirePar: true }
      : values["no-require-par"] === true
        ? { requirePar: false }
        : {}),
    ...(values["dpop-bound"] === true
      ? { dpopBound: true }
      : values["no-dpop-bound"] === true
        ? { dpopBound: false }
        : {}),
    ...(values["detail-types"] === undefined
      ? {}
      : {
          detailTypes: values["detail-types"]
            .split(",")
            .map((type) => type.trim())
            .filter((type) => type !== ""),
        }),
    ...(values["allowed-scopes"] === undefined
      ? {}
      : { allowedScopes: list(values["allowed-scopes"]) }),
    ...(values["default-scopes"] === undefined
      ? {}
      : { defaultScopes: list(values["default-scopes"]) }),
    ...(values["rotate-secret"] === true ? { rotateSecret: true } : {}),
  };
}

function read(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    options: {
      tenant: { type: "string" },
      name: { type: "string" },
      "redirect-uri": { type: "string", multiple: true },
      confidential: { type: "boolean" },
      "client-id": { type: "string" },
      grants: { type: "string" },
      "rotate-secret": { type: "boolean" },
      "require-par": { type: "boolean" },
      "no-require-par": { type: "boolean" },
      "detail-types": { type: "string" },
      "allowed-scopes": { type: "string" },
      "default-scopes": { type: "string" },
      "dpop-bound": { type: "boolean" },
      "no-dpop-bound": { type: "boolean" },
    },
  });
}
