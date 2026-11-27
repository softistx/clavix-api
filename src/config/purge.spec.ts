import { describe, expect, spyOn, test } from "bun:test";
import { tenantsService } from "@/config/tenancy";
import { purgeAtOf } from "@/modules/tenants/tenants.trash";
import { defined } from "~/narrow";
import { partitions, seed, useTenantPurgeHooks } from "~/tenant-purge";
import { avatarObjects } from "./media-objects";
import { createTenantPurge } from "./purge";

useTenantPurgeHooks();

describe("the tenant purge job", () => {
  test("removes the tenant's picture folder, and only the purged tenant's", async () => {
    const a = await seed("pics-a");
    await seed("pics-b");
    const purged = spyOn(avatarObjects, "purgeTenant");
    try {
      const trashed = await tenantsService.trash(a._id.toHexString());
      const due = purgeAtOf(defined(trashed.deletedAt, "the deletion date"));
      expect(await createTenantPurge(() => due, partitions)()).toMatchObject({
        purged: [a._id.toHexString()],
      });
      expect(purged.mock.calls).toEqual([[a._id.toHexString()]]);
    } finally {
      purged.mockRestore();
    }
  });
});
