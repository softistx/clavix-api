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

Seals again, under the first key of CLAVIX_KEYS_MASTER_KEY, everything stored under the keyring,
for every tenant (suspended and trashed included), and prints the counts as JSON:
  resealed, current, skipped, failed   the signing keys
  secondFactor                         the users' TOTP secrets (janus secondFactor.reseal, in batches)
  webhookSecrets                       the webhook endpoints' signing secrets, rolled ones included
  connectionSecrets                    the enterprise connections' client secrets
  socialSecrets                        the social providers' client secrets
  oldKeyNeededBy                       every count that still needs the old key; empty when it can go

Exits 1 while anything was skipped (changed meanwhile: run it again), a tenant failed, a secret is
unreadable (no key of the list opens it: put the missing key back, or enter that secret again) or
"behind" (still under an older key after the pass). Recovery codes are hashes and cannot be sealed
again: they do not fail the run, but keep the old key until their users have new ones
(secondFactor.recoveryCodesBehind). Drop the old key only when oldKeyNeededBy is empty.`;

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
