import { parseArgs } from "node:util";
import { CliInputError } from "@/shared/cli";
import type { RegisterResourceInput } from "./register-resource";

export const USAGE = `Usage: bun run resources:create --tenant <slug> --uri <uri> --scope <scope> [options]

  --tenant <slug>   the tenant the resource is registered on (required)
  --uri <uri>       the API's audience URI, https (required); re-running with the same URI updates it
  --scope <scope>   a scope a client may request on it; repeat for several (at least one)
  --name <name>     a label; default: the URI's host`;

/** The script's flags as a registration input; a `CliInputError` for a bad line. */
export function parseResourceArgs(
  argv: readonly string[],
): RegisterResourceInput {
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
  if (values.uri === undefined) throw new CliInputError("--uri is required");
  return {
    tenant: values.tenant,
    uri: values.uri,
    scopes: values.scope ?? [],
    ...(values.name === undefined ? {} : { name: values.name }),
  };
}

function read(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    options: {
      tenant: { type: "string" },
      uri: { type: "string" },
      scope: { type: "string", multiple: true },
      name: { type: "string" },
    },
  });
}
