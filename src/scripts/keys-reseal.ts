import { mongo } from "@/config/db";
import { masterKeys } from "@/config/keys";
import { redis } from "@/config/redis";
import { tenantsService } from "@/config/tenancy";
import { resealAllTenants, resealExitCode } from "@/keys";
import { RESEAL_USAGE } from "@/keys/cli";

// Step 3 of a master-key rotation (docs/operations.md, "Rotating the master
// key"): re-seals every tenant's stored signing keys under the first key of
// CLAVIX_KEYS_MASTER_KEY (a comma-separated keyring, the first seals). Prints
// the counts as JSON; exits 1 while records were skipped or a tenant failed.
// Run it until it answers resealed 0, skipped 0, failed 0.
//
//   bun run keys:reseal
const args = Bun.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(RESEAL_USAGE);
  process.exit(0);
}
try {
  const report = await resealAllTenants({
    db: mongo.db,
    masterKeys,
    tenantIds: () => tenantsService.allIds(),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = resealExitCode(report);
} finally {
  await mongo.close();
  await redis?.close();
}
