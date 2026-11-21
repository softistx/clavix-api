import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { createTenancy } from "@/config/tenancy";
import type { TxtAnswer } from "@/modules/domains";
import { DomainsService } from "@/modules/domains";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { memoryTenantCache } from "@/tenancy/tenant-cache";
import { noCustomDomains, quietDomains } from "~/ports";

// createTenancy (the wiring of src/config/tenancy.ts) on the wired collection,
// with the in-memory cache in place of Redis.
const cache = memoryTenantCache(Date.now);
const { tenantResolver: resolver, tenantsService: service } = createTenancy({
  domains: noCustomDomains.domains,
  hostsOf: async () => [],
  onCreated: async () => {},
  log: () => {},
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
  await mongo.db.domains.raw.deleteMany({});
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

    // A suspended tenant still resolves (its discovery and keys answer); callers check `isLive`.
    await service.suspend(tenant._id);
    expect(await resolver.resolveHost(host)).toMatchObject({
      status: "suspended",
    });
  });
});

describe("custom domains in the production wiring", () => {
  test("a verified custom domain reaches relatedOrigins through the domains object of config/tenancy.ts", async () => {
    const tenant = await service.create({ slug: "acme", name: "Acme" });
    const records = new Map<string, TxtAnswer>();
    const store = new DomainsService(mongo.db.domains, {
      ...quietDomains,
      dns: {
        resolveTxt: async (name) => records.get(name) ?? { kind: "none" },
      },
      platformDomain: env.CLAVIX_DOMAIN,
      log: () => {},
      now: () => new Date(),
    });
    const tenancy = createTenancy({
      onCreated: async () => {},
      log: () => {},
      tenants: mongo.db.tenants,
      cache: memoryTenantCache(Date.now),
      config: {
        scheme: env.CLAVIX_PUBLIC_SCHEME,
        domain: env.CLAVIX_DOMAIN,
        port: env.CLAVIX_PUBLIC_PORT,
      },
      // The same object config/tenancy.ts builds, over a store with a fake DNS.
      domains: {
        tenantOfHost: (h) => store.tenantOfHost(h),
        primaryHostOf: (tenantId) => store.primaryHostOf(tenantId),
        verifiedHostsOf: (tenantId) => store.verifiedHostsOf(tenantId),
      },
      hostsOf: (tenantId) => store.resolvingHostsOf(tenantId),
    });
    expect(
      (await tenancy.tenantResolver.resolveHost(host))?.relatedOrigins,
    ).toEqual([]);

    const custom = "login.acme-corp.com";
    const claim = await store.add(tenant._id, custom, null);
    records.set(`_clavix.${custom}`, {
      kind: "records",
      values: [claim.txtToken],
    });
    await store.verify(tenant._id, claim._id.toHexString());
    await tenancy.tenantResolver.invalidate([host, custom]);

    expect(
      (await tenancy.tenantResolver.resolveHost(host))?.relatedOrigins,
    ).toContain(`https://${custom}`);
  });
});
