import { parseArgs } from "node:util";
import { type RegisterTenantInput, TenantInputError } from "./register-tenant";

export const USAGE = `Usage: bun run tenants:create --slug <slug> --name <name> [options]

  --slug <slug>   the tenant's DNS label: its issuer is https://<slug>.<CLAVIX_DOMAIN> (required, never changes)
  --name <name>   the display name (required)
  --sign-up       open sign-up for unknown e-mails; default is closed (invitation only)

Re-running with the same values creates nothing; other values for an existing slug are refused.
A reserved slug, and the slug of a deleted tenant, are refused.`;

/** The script's flags as a registration input; a `TenantInputError` for a bad line. */
export function parseTenantArgs(argv: readonly string[]): RegisterTenantInput {
  let values: ReturnType<typeof read>["values"];
  try {
    values = read(argv).values;
  } catch (error) {
    throw new TenantInputError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (values.slug === undefined)
    throw new TenantInputError("--slug is required");
  if (values.name === undefined)
    throw new TenantInputError("--name is required");
  return {
    slug: values.slug,
    name: values.name,
    ...(values["sign-up"] === true ? { signUp: true } : {}),
  };
}

function read(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    options: {
      slug: { type: "string" },
      name: { type: "string" },
      "sign-up": { type: "boolean" },
    },
  });
}
