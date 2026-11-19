import { parseArgs } from "node:util";
import { CliInputError } from "@/cli/errors";

export const ROTATE_USAGE = `Usage: bun run keys:rotate <tenant-slug> [--drop-old]
       bun run keys:rotate --all [--drop-old]

Emergency rotation: retires the tenant's current signing key now and makes a new one sign.
  <tenant-slug>   the tenant to rotate
  --all           every active tenant
  --drop-old      also unpublish the retired key at once (a leaked private key): the tokens
                  it signed stop verifying. Default: it stays published for 24 h.`;

export const RESEAL_USAGE = `Usage: bun run keys:reseal

Re-seals every tenant's stored signing keys under the first key of CLAVIX_KEYS_MASTER_KEY.
Prints the counts as JSON; exits 1 while records were skipped or a tenant failed: run it again.
It also counts the TOTP secrets and recovery codes still sealed under an older key (secondFactor.behind):
they move to the first key on their user's next accepted code, so keep the old key until that is 0.`;

export type RotateTarget =
  | { all: true; dropOld: boolean }
  | { all: false; slug: string; dropOld: boolean };

/** The `keys:rotate` line as a target; a `CliInputError` for a bad one. */
export function parseRotateArgs(argv: readonly string[]): RotateTarget {
  let parsed: ReturnType<typeof read>;
  try {
    parsed = read(argv);
  } catch (error) {
    throw new CliInputError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const { values, positionals } = parsed;
  const dropOld = values["drop-old"] === true;
  if (values.all === true) {
    if (positionals.length > 0) {
      throw new CliInputError("give a tenant slug or --all, not both");
    }
    return { all: true, dropOld };
  }
  const [slug, ...rest] = positionals;
  if (slug === undefined) {
    throw new CliInputError("a tenant slug (or --all) is required");
  }
  if (rest.length > 0) throw new CliInputError("only one tenant slug");
  return { all: false, slug, dropOld };
}

function read(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      "drop-old": { type: "boolean" },
    },
  });
}
