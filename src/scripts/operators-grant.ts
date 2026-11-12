import { CliInputError } from "@/cli/errors";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { redis } from "@/config/redis";
import { tenantResolver } from "@/config/tenancy";
import { forTenant } from "@/config/users";
import {
  grantOperator,
  OPERATORS_USAGE,
  parseOperatorArgs,
} from "@/console/operators";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";

// Grants a platform role (default owner) to a user of the clavix tenant, until
// the console can. Idempotent. See `bun run operators:grant --help`.
//
//   bun run operators:grant --email ada@example.com
const args = Bun.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(OPERATORS_USAGE);
  process.exit(0);
}
try {
  const input = parseOperatorArgs(args);
  const tenant = await tenantResolver.resolveHost(
    `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
  );
  const janus = tenant === null ? null : await forTenant(tenant);
  if (janus === null) {
    throw new CliInputError("the clavix tenant is missing or suspended");
  }
  console.log(
    JSON.stringify(
      await grantOperator(
        { findByEmail: (e) => janus.findByEmail(e), access },
        input,
      ),
      null,
      2,
    ),
  );
} catch (error) {
  if (!(error instanceof CliInputError)) throw error;
  console.error(`operators:grant: ${error.message}\n\n${OPERATORS_USAGE}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
  await redis?.close();
}
