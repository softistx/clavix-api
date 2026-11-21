import { access } from "@/config/access";
import { adminEventRecorder } from "@/config/admin-events";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { exclusive } from "@/config/exclusive";
import { invitationsOf } from "@/config/invitations";
import { redis } from "@/config/redis";
import { tenantResolver } from "@/config/tenancy";
import { forTenant } from "@/config/users";
import { userKey } from "@/console/modules/user-key";
import {
  grantOperator,
  OPERATORS_USAGE,
  operatorGrantDeps,
  parseOperatorArgs,
} from "@/console/operators";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { CliInputError } from "@/shared/cli";

// Grants a platform role (default owner) to a user of the clavix tenant, until
// the console can. Idempotent. See `bun run operators:grant --help`.
//
//   bun run operators:grant --email ada@example.com
//   bun run operators:grant --email ada@example.com --create   # fresh database
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
  if (tenant === null || janus === null) {
    throw new CliInputError("the clavix tenant is missing or suspended");
  }
  console.log(
    JSON.stringify(
      await grantOperator(
        operatorGrantDeps({
          findByEmail: (e) => janus.findByEmail(e),
          access,
          lock: (id, work) => exclusive(userKey(tenant.tenantId, id), work),
          invitations: invitationsOf(async () => tenant),
          recorder: adminEventRecorder,
        }),
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
