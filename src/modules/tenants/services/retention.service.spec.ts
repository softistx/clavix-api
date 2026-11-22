import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { tenantRetentionService, tenantsService } from "@/config/tenancy";
import { defined } from "~/narrow";
import { PLATFORM_TENANT_SLUG } from "../tenants.rules";
import { purgeAtOf } from "../tenants.trash";

afterEach(() =>
  mongo.db.tenants.raw.deleteMany({ slug: { $ne: PLATFORM_TENANT_SLUG } }),
);

const make = (slug: string, name = `${slug} Inc`) =>
  tenantsService.create({ slug, name });

describe("TenantRetentionService", () => {
  test("purgeDue and claimPurge follow the 30 days; a claimed tenant cannot be restored", async () => {
    const t = await make("acme");
    const id = t._id.toHexString();
    const trashed = await tenantsService.trash(id);
    const due = purgeAtOf(defined(trashed.deletedAt, "the deletion date"));
    const before = new Date(due.getTime() - 1000);
    expect(
      (await tenantRetentionService.purgeDue(before)).map((x) => x.slug),
    ).toEqual([]);
    expect(await tenantRetentionService.claimPurge(trashed, before)).toBe(
      false,
    );
    expect(
      (await tenantRetentionService.purgeDue(due)).map((x) => x.slug),
    ).toEqual(["acme"]);
    expect(await tenantRetentionService.claimPurge(trashed, due)).toBe(true);
    expect(await tenantRetentionService.claimPurge(trashed, due)).toBe(true); // a resume
    expect(await tenantsService.find(id)).toBeUndefined();
    await expect(tenantsService.restore(id)).rejects.toThrow();
    // still due until marked purged
    expect(await tenantRetentionService.purgeDue(due)).toHaveLength(1);
    await tenantRetentionService.markPurged(trashed, due);
    expect(await tenantRetentionService.purgeDue(due)).toEqual([]);
    expect(await tenantRetentionService.claimPurge(trashed, due)).toBe(false);
  });

  test("a live tenant is not due", async () => {
    await make("acme");
    expect(
      await tenantRetentionService.purgeDue(new Date("2099-01-01")),
    ).toEqual([]);
  });

  test("retentionTargets lists every tenant with its plan, the trashed ones included", async () => {
    const live = await make("acme");
    const gone = await make("beta");
    await tenantsService.trash(gone._id.toHexString());
    const targets = await tenantRetentionService.retentionTargets();
    expect(targets).toContainEqual({
      id: live._id.toHexString(),
      plan: live.plan,
    });
    expect(targets.map((t) => t.id)).toContain(gone._id.toHexString());
  });
});
