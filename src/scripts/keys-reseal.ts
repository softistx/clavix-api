import { connectionsService } from "@/config/connections";
import { mongo } from "@/config/db";
import { masterKeys } from "@/config/keys";
import { redis } from "@/config/redis";
import { warn } from "@/config/runtime";
import { signInPolicyService } from "@/config/sign-in-policy";
import { tenantsService } from "@/config/tenancy";
import { webhooksService } from "@/config/webhooks-service";
import {
  RESEAL_USAGE,
  resealAllTenants,
  resealExitCode,
  resealSecondFactorOf,
} from "@/modules/keys";
import { secondFactorKeysOf } from "@/modules/users";

// Step 3 of a master-key rotation (docs/operations.md, "Rotating the master
// key"): seals again, under the first key of CLAVIX_KEYS_MASTER_KEY (a
// comma-separated keyring, the first seals), everything stored under the
// keyring: the signing keys, the TOTP secrets, the webhook secrets and the
// connection and social client secrets. Prints the counts as JSON; exits 1
// while anything is left under an older key or to retry. The old key is
// dropped only once `oldKeyNeededBy` is empty.
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
    log: warn,
    resealSecondFactor: resealSecondFactorOf(
      mongo.db,
      secondFactorKeysOf(masterKeys),
    ),
    tenantIds: () => tenantsService.allIds(),
    secretStores: {
      webhookSecrets: (tenantId) => webhooksService.resealSecrets(tenantId),
      connectionSecrets: (tenantId) =>
        connectionsService.resealSecrets(tenantId),
      socialSecrets: (tenantId) => signInPolicyService.resealSecrets(tenantId),
    },
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.oldKeyNeededBy.length > 0) {
    console.error(
      `keys: keep the old master key in CLAVIX_KEYS_MASTER_KEY (${report.oldKeyNeededBy.join(", ")})`,
    );
  }
  process.exitCode = resealExitCode(report);
} finally {
  await mongo.close();
  await redis?.close();
}
