import { afterEach, describe, expect, test } from "bun:test";
import { getCollection } from "@softistx/mongo";
import { mongo } from "@/config/db";
import { PLATFORM_TENANT_SLUG } from "./slug";
import {
  InvalidSlugError,
  PlatformTenantProtectedError,
  SlugTakenError,
} from "./tenants.errors";
import { tenants } from "./tenants.model";
import { TenantsService } from "./tenants.service";

const collection = getCollection(mongo.db, tenants);
const hosts: string[][] = [];
const service = new TenantsService(collection, {
  domain: "clavix.test",
  onHostsChanged: (changed) => {
    hosts.push(changed);
  },
});

// `clearDatabase` keeps `tenants` (the seed): a spec removes its own.
afterEach(async () => {
  hosts.length = 0;
  await collection.raw.deleteMany({ slug: { $ne: PLATFORM_TENANT_SLUG } });
});

describe("TenantsService", () => {
  test("create makes an active tenant and invalidates its host", async () => {
    const tenant = await service.create({ slug: "acme", name: " Acme " });
    expect(tenant).toMatchObject({
      slug: "acme",
      name: "Acme",
      status: "active",
    });
    expect(hosts).toEqual([["acme.clavix.test"]]);
  });

  test("a reserved, malformed or duplicate slug is refused", async () => {
    await expect(service.create({ slug: "www", name: "W" })).rejects.toThrow(
      InvalidSlugError,
    );
    await expect(service.create({ slug: "Bad", name: "B" })).rejects.toThrow(
      InvalidSlugError,
    );
    await service.create({ slug: "acme", name: "Acme" });
    await expect(service.create({ slug: "acme", name: "Two" })).rejects.toThrow(
      SlugTakenError,
    );
  });

  test("the seeded platform slug is taken", async () => {
    await expect(
      service.create({ slug: PLATFORM_TENANT_SLUG, name: "Again" }),
    ).rejects.toThrow(SlugTakenError);
  });

  test("suspend and reactivate change the status, raise the version, invalidate", async () => {
    const tenant = await service.create({ slug: "acme", name: "Acme" });
    hosts.length = 0;
    const suspended = await service.suspend(tenant._id);
    expect(suspended.status).toBe("suspended");
    expect(suspended.version).toBeGreaterThan(tenant.version);
    const active = await service.reactivate(tenant._id);
    expect(active.status).toBe("active");
    expect(active.version).toBeGreaterThan(suspended.version);
    expect(hosts).toEqual([["acme.clavix.test"], ["acme.clavix.test"]]);
  });

  test("suspending a suspended tenant writes nothing", async () => {
    const tenant = await service.create({ slug: "acme", name: "Acme" });
    await service.suspend(tenant._id);
    hosts.length = 0;
    const again = await service.suspend(tenant._id);
    expect(again.status).toBe("suspended");
    expect(hosts).toEqual([]);
  });

  test("delete archives the tenant, frees the slug and invalidates", async () => {
    const tenant = await service.create({ slug: "acme", name: "Acme" });
    hosts.length = 0;
    await service.delete(tenant._id);
    expect(await collection.findById(tenant._id)).toBeUndefined();
    expect(hosts).toEqual([["acme.clavix.test"]]);
    const again = await service.create({ slug: "acme", name: "Acme 2" });
    expect(again._id).not.toEqual(tenant._id);
  });

  test("the platform tenant cannot be suspended or deleted", async () => {
    const platform = await collection.findFirst({ slug: PLATFORM_TENANT_SLUG });
    expect(platform).toBeDefined();
    const id = (platform as NonNullable<typeof platform>)._id;
    await expect(service.suspend(id)).rejects.toThrow(
      PlatformTenantProtectedError,
    );
    await expect(service.delete(id)).rejects.toThrow(
      PlatformTenantProtectedError,
    );
    expect(hosts).toEqual([]);
    // Reactivating it is harmless.
    expect((await service.reactivate(id)).status).toBe("active");
  });
});
