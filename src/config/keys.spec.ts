import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { jwksFor, signingKeysFor } from "@/config/keys";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { clearDatabase } from "~/db";

afterEach(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await clearDatabase();
});

describe("signing keys wiring", () => {
  test("a new tenant has a signing key before its first token", async () => {
    const tenant = await tenantsService.create({ slug: "acme", name: "Acme" });
    const id = tenant._id.toHexString();
    const current = await signingKeysFor(id).findCurrentKey(new Date());
    expect(current).not.toBeNull();
    const { keys } = await jwksFor(id);
    expect(keys.map((k) => k.kid)).toEqual([current?.kid as string]);
  });

  test("activeIds lists active tenants only", async () => {
    const a = await tenantsService.create({ slug: "acme", name: "Acme" });
    const b = await tenantsService.create({ slug: "beta", name: "Beta" });
    await tenantsService.suspend(b._id);
    const ids = await tenantsService.activeIds();
    expect(ids).toContain(a._id.toHexString());
    expect(ids).not.toContain(b._id.toHexString());
  });
});
