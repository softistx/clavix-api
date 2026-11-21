import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { redis } from "@/config/redis";
import { clientDetailTypes } from "@/config/resources";
import { clock } from "@/config/runtime";
import { tenantBySlug } from "@/config/tenancy";
import { parseClientArgs, USAGE } from "@/modules/clients/cli";
import { registerClient } from "@/modules/clients/register-client";
import { issuerOf } from "@/modules/tenants";
import { CliInputError } from "@/shared/cli";

// Registers an OAuth client on a tenant, or updates it (idempotent on the
// client id), until the console exists (M2). Prints the client as JSON; a
// confidential client's secret is in the output once and janus keeps only its
// hash, so copy it where the client runs. See `bun run clients:create --help`.
//
//   bun run clients:create --tenant acme --name "Back office" \
//     --redirect-uri https://office.example.com/callback --confidential
const args = Bun.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
try {
  const result = await registerClient(
    {
      db: oauthDb,
      findTenant: tenantBySlug,
      detailTypes: clientDetailTypes,
      now: clock,
    },
    parseClientArgs(args),
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        issuer: issuerOf(result.tenant, {
          scheme: env.CLAVIX_PUBLIC_SCHEME,
          domain: env.CLAVIX_DOMAIN,
          port: env.CLAVIX_PUBLIC_PORT,
        }),
        ...(result.clientSecret === null
          ? {}
          : { note: "clientSecret is shown once and stored hashed" }),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (!(error instanceof CliInputError)) throw error;
  console.error(`clients:create: ${error.message}\n\n${USAGE}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
  await redis?.close();
}
