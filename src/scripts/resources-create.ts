import { mongo } from "@/config/db";
import { redis } from "@/config/redis";
import { registerStoredResource } from "@/config/resources";
import { parseResourceArgs, USAGE } from "@/modules/resources/cli";
import { CliInputError } from "@/shared/cli";

// Registers a protected resource (an API audience and its scopes) on a tenant,
// or updates it (idempotent on the URI), until the console exists (M2). Access
// tokens asked with `resource=<uri>` then carry it as `aud`. Prints the
// resource as JSON. See `bun run resources:create --help`.
//
//   bun run resources:create --tenant acme --uri https://api.acme.example \
//     --scope read --scope write
const args = Bun.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
try {
  const input = parseResourceArgs(args);
  const result = await registerStoredResource(input);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (!(error instanceof CliInputError)) throw error;
  console.error(`resources:create: ${error.message}\n\n${USAGE}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
  await redis?.close();
}
