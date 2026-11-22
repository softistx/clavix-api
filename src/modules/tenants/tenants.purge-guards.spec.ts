import { describe, expect, test } from "bun:test";
import { scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { ownedPurgers } from "@/config/purge";
import { tenantsService } from "@/config/tenancy";
import { defined } from "~/narrow";
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
} from "~/tenant-purge";
import { purgeAtOf } from "./tenants.trash";

useTenantPurgeHooks();

describe("the tenant purge guards", () => {
  test("never touches adminEvents, which is a platform collection", () => {
    const names = ownedPurgers().map((p) => p.name);
    expect(names).toContain("branding");
    expect(names).toContain("usageCounters");
    // The roles and their assignments are tenant-owned: purged with it.
    expect(names).toContain("roles");
    expect(names).toContain("roleAssignments");
    // The clients' rules (token exchange) go with the tenant too.
    expect(names).toContain("clientPolicies");
    expect(names).not.toContain("adminEvents");
    // The authorization detail types go with the tenant too.
    expect(names).toContain("detailTypes");
    // The agents (dynamic and metadata clients) go with the tenant too.
    expect(names).toContain("agentClients");
  });
  test("the purge empties a tenant's detailTypes and no other's", async () => {
    const purger = ownedPurgers().find((p) => p.name === "detailTypes");
    const a = new ObjectId();
    const b = new ObjectId();
    for (const tenantId of [a, b]) {
      await scopeToTenant(mongo.db.detailTypes, tenantId).create({
        resourceId: new ObjectId(),
        type: "payment",
        name: [],
        description: [],
        fields: [],
      });
    }
    expect(await purger?.deleteOwnedBy(a)).toBe(1);
    expect(await mongo.db.detailTypes.raw.countDocuments({ tenantId: a })).toBe(
      0,
    );
    expect(await purger?.deleteOwnedBy(b)).toBe(1);
  });
  test("the purge empties a tenant's clientPolicies and no other's", async () => {
    const purger = ownedPurgers().find((p) => p.name === "clientPolicies");
    const a = new ObjectId();
    const b = new ObjectId();
    for (const tenantId of [a, b]) {
      await scopeToTenant(mongo.db.clientPolicies, tenantId).create({
        clientId: "exch",
      });
    }
    expect(await purger?.deleteOwnedBy(a)).toBe(1);
    expect(
      await mongo.db.clientPolicies.raw.countDocuments({ tenantId: a }),
    ).toBe(0);
    expect(await purger?.deleteOwnedBy(b)).toBe(1);
  });
  test("every purger reaches a real collection", async () => {
    for (const purger of ownedPurgers()) {
      expect(await purger.deleteOwnedBy(new ObjectId())).toBe(0);
    }
  });
  test("refuses a tenant before its purgeAt and a tenant not in the trash", async () => {
    const a = await seed("alpha");
    await seed("bravo"); // not deleted
    const trashed = await tenantsService.trash(a._id.toHexString());
    const due = purgeAtOf(defined(trashed.deletedAt, "the deletion date"));
    expect(await run(at(due, -1))).toEqual({ purged: [], failed: [] });
    expect(await janusCount(a._id.toHexString())).toBeGreaterThanOrEqual(
      JANUS.length,
    );
    expect(await ownedCount(a)).toBe(2);
    expect(
      (await tenantsService.find(a._id.toHexString()))?.purgeStartedAt,
    ).toBeUndefined();
  });
  test("a tenant deleted 29 days ago is left alone, whole", async () => {
    const a = await seed("alpha");
    const id = a._id.toHexString();
    const trashed = await tenantsService.trash(id);
    const before = await janusOf(id);
    expect(
      await run(at(defined(trashed.deletedAt, "the deletion date"), 29)),
    ).toEqual({
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
    const trashed = await tenantsService.trash(restored._id.toHexString());
    await tenantsService.restore(restored._id.toHexString());
    const far = at(defined(trashed.deletedAt, "the deletion date"), 400);
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
