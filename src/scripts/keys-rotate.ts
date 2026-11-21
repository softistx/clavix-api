import { mongo } from "@/config/db";
import { keysService } from "@/config/keys";
import { redis } from "@/config/redis";
import { tenantsCollection, tenantsService } from "@/config/tenancy";
import { parseRotateArgs, ROTATE_USAGE } from "@/modules/keys";
import { partitionOf } from "@/modules/tenants";
import { CliInputError, UnknownTenantError } from "@/shared/cli";

// Emergency rotation (a signing key leaked): retires the tenant's current key
// now and makes a new one sign, through janus's own `retire` and rotation
// step; nothing is deleted by hand. The old key stays published 24 h, or is
// unpublished at once with --drop-old. Prints what each tenant did as JSON;
// exits 1 when a tenant failed.
//
//   bun run keys:rotate acme
//   bun run keys:rotate --all --drop-old
const args = Bun.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(ROTATE_USAGE);
  process.exit(0);
}
try {
  const target = parseRotateArgs(args);
  let tenantIds: string[];
  if (target.all) {
    tenantIds = await tenantsService.activeIds();
  } else {
    const tenant = await tenantsCollection.findFirst({ slug: target.slug });
    if (tenant === undefined || tenant === null) {
      throw new UnknownTenantError(target.slug);
    }
    tenantIds = [partitionOf(tenant._id)];
  }
  const { rotated, failed } = await keysService.rotateNow(tenantIds, {
    dropOld: target.dropOld,
  });
  console.log(JSON.stringify({ rotated, failed }, null, 2));
  if (failed > 0) process.exitCode = 1;
} catch (error) {
  if (!(error instanceof CliInputError)) throw error;
  console.error(`keys:rotate: ${error.message}\n\n${ROTATE_USAGE}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
  await redis?.close();
}
