import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { ownedPurgers } from "@/config/purge";
import { tenantAdmin, tenantsService } from "@/config/tenancy";
import {
  at,
  can,
  JANUS,
  janusCount,
  janusOf,
  ownedCount,
  real,
  run,
  seed,
  seedJanus,
  useTenantPurgeHooks,
} from "./purge.fixtures";
import { purgeAtOf } from "./trash.schema";

useTenantPurgeHooks();

describe("the tenant purge guards", () => {
  test("never touches adminEvents, which is a platform collection", () => {
    const names = ownedPurgers().map((p) => p.name);
    expect(names).toContain("branding");
    expect(names).toContain("usageCounters");
    // The roles and their assignments are tenant-owned: purged with it.
    expect(names).toContain("roles");
    expect(names).toContain("roleAssignments");
    expect(names).not.toContain("adminEvents");
  });
  test("every purger reaches a real collection", async () => {
    for (const purger of ownedPurgers()) {
      expect(await purger.deleteOwnedBy(new ObjectId())).toBe(0);
    }
  });
  test("refuses a tenant before its purgeAt and a tenant not in the trash", async () => {
    const a = await seed("alpha");
    await seed("bravo"); // not deleted
    const trashed = await tenantAdmin.trash(a._id.toHexString());
    const due = purgeAtOf(trashed.deletedAt as Date);
    expect(await run(at(due, -1))).toEqual({ purged: [], failed: [] });
    expect(await janusCount(a._id.toHexString())).toBeGreaterThanOrEqual(
      JANUS.length,
    );
    expect(await ownedCount(a)).toBe(2);
    expect(
      (await tenantAdmin.find(a._id.toHexString()))?.purgeStartedAt,
    ).toBeUndefined();
  });
  test("a tenant deleted 29 days ago is left alone, whole", async () => {
    const a = await seed("alpha");
    const id = a._id.toHexString();
    const trashed = await tenantAdmin.trash(id);
    const before = await janusOf(id);
    expect(await run(at(trashed.deletedAt as Date, 29))).toEqual({
      purged: [],
      failed: [],
    });
    expect(await janusOf(id)).toEqual(before);
    expect(await ownedCount(a)).toBe(2);
    expect(await can(a, "user-alpha")).toBe(true);
  });
  test("a restored tenant, and a live or suspended one, are never purged", async () => {
    const restored = await seed("alpha");
    const live = await seed("bravo");
    const paused = await seed("charlie");
    await tenantsService.suspend(paused._id.toHexString());
    const trashed = await tenantAdmin.trash(restored._id.toHexString());
    await tenantAdmin.restore(restored._id.toHexString());
    const far = at(trashed.deletedAt as Date, 400);
    expect(await run(far)).toEqual({ purged: [], failed: [] });
    for (const tenant of [restored, live, paused]) {
      expect(await janusCount(tenant._id.toHexString())).toBeGreaterThanOrEqual(
        JANUS.length,
      );
      expect(await ownedCount(tenant)).toBe(2);
    }
  });
  test("refuses the default partition and an empty one, touching nothing", async () => {
    await seedJanus("default");
    const before = await janusOf("default");
    await expect(real.purgePartition("default")).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(real.purgePartition("")).rejects.toBeInstanceOf(TypeError);
    expect(await janusOf("default")).toEqual(before);
  });
});
