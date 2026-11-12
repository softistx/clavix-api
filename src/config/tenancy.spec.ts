import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { TenantsService } from "@/modules/tenants";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { createTenantResolver } from "@/tenancy/resolver";
import { memoryTenantCache } from "@/tenancy/tenant-cache";

// The wiring of src/config/tenancy.ts (lookup on the wired collection, the
// service's onHostsChanged calling invalidate), with the in-memory cache in
// place of Redis.
const cache = memoryTenantCache();
const resolver = createTenantResolver({
  lookup: (slug) => mongo.db.tenants.findFirst({ slug }),
  cache,
  config: {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    domain: env.CLAVIX_DOMAIN,
    port: env.CLAVIX_PUBLIC_PORT,
  },
});
const service = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => resolver.invalidate(hosts),
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
