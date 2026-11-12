import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { resourcesCollection } from "@/config/resources";
import { tenantBySlug } from "@/config/tenancy";
import { parseResourceArgs, USAGE } from "@/modules/resources/cli";
import {
  ResourceInputError,
  registerResource,
} from "@/modules/resources/register-resource";
import { issuerOf } from "@/modules/tenants/identity";

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
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
};
try {
  const input = parseResourceArgs(args);
  const result = await registerResource(
    {
      collection: resourcesCollection,
      findTenant: tenantBySlug,
      issuerOf: (slug) => issuerOf(slug, origin),
    },
    input,
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (!(error instanceof ResourceInputError)) throw error;
  console.error(`resources:create: ${error.message}\n\n${USAGE}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
