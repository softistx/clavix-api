import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { createTenancy } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { memoryTenantCache } from "@/tenancy/tenant-cache";

// createTenancy (the wiring of src/config/tenancy.ts) on the wired collection,
// with the in-memory cache in place of Redis.
const cache = memoryTenantCache();
const { tenantResolver: resolver, tenantsService: service } = createTenancy({
  tenants: mongo.db.tenants,
  cache,
  config: {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    domain: env.CLAVIX_DOMAIN,
    port: env.CLAVIX_PUBLIC_PORT,
  },
});
const host = `acme.${env.CLAVIX_DOMAIN}`;

afterEach(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await cache.delete(host);
});

describe("tenant resolver wiring", () => {
  test("unknown (cached null), created, suspended", async () => {
    expect(await resolver.resolveHost(host)).toBeNull();
    expect(await cache.get(host)).toBeNull();

    const tenant = await service.create({ slug: "acme", name: "Acme" });
    expect(await resolver.resolveHost(host)).toMatchObject({
      tenantId: tenant._id.toHexString(),
      slug: "acme",
    });

    await service.suspend(tenant._id);
    expect(await resolver.resolveHost(host)).toBeNull();
  });
});
