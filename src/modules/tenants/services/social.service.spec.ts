import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { tenantSocialService, tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "../tenants.rules";

afterEach(() =>
  mongo.db.tenants.raw.deleteMany({ slug: { $ne: PLATFORM_TENANT_SLUG } }),
);

describe("TenantSocialService", () => {
  test("replaceSocial writes the apps and bumps the version, a stale read writes nothing", async () => {
    const tenant = await tenantsService.create({ slug: "acme", name: "Acme" });
    expect(await tenantSocialService.replaceSocial(tenant, [])).toBe(true);
    const written = await tenantsService.get(tenant._id.toHexString());
    expect(written.version).toBe(tenant.version + 1);
    expect(await tenantSocialService.replaceSocial(tenant, [])).toBe(false);
    expect((await tenantsService.get(tenant._id.toHexString())).version).toBe(
      written.version,
    );
  });

  test("replaceSocial writes a tenant in the trash too", async () => {
    const tenant = await tenantsService.create({ slug: "acme", name: "Acme" });
    await tenantsService.trash(tenant._id.toHexString());
    const trashed = await tenantsService.anyById(tenant._id.toHexString());
    if (trashed === undefined) throw new Error("no tenant");
    expect(await tenantSocialService.replaceSocial(trashed, [])).toBe(true);
  });
});
