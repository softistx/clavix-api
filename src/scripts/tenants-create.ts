import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { tenantsCollection, tenantsService } from "@/config/tenancy";
import { parseTenantArgs, USAGE } from "@/modules/tenants/cli";
import { issuerOf } from "@/modules/tenants/identity";
import {
  registerTenant,
  TenantInputError,
} from "@/modules/tenants/register-tenant";

// Creates a tenant until the console exists (M2), through the same service the
// platform uses (slug rules, reserved slugs, first signing key). Idempotent:
// re-running with the same values creates nothing. Prints the tenant as JSON,
// with its issuer. See `bun run tenants:create --help`.
//
//   bun run tenants:create --slug acme --name "Acme"
const args = Bun.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
try {
  const result = await registerTenant(
    { service: tenantsService, collection: tenantsCollection },
    parseTenantArgs(args),
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        issuer: issuerOf(result.slug, {
          scheme: env.CLAVIX_PUBLIC_SCHEME,
          domain: env.CLAVIX_DOMAIN,
          port: env.CLAVIX_PUBLIC_PORT,
        }),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (!(error instanceof TenantInputError)) throw error;
  console.error(`tenants:create: ${error.message}\n\n${USAGE}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
