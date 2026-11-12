import { afterEach, describe, expect, test } from "bun:test";
import { OptimisticLockError } from "@softistx/mongo";
import { mongo } from "@/config/db";
import { PLATFORM_TENANT_SLUG } from "./slug";
import {
  InvalidSlugError,
  PlatformTenantProtectedError,
  SlugTakenError,
} from "./tenants.errors";
import { TenantsService } from "./tenants.service";

// The wired collection: it carries the slug hooks (src/config/db.ts).
const collection = mongo.db.tenants;
const hosts: string[][] = [];
const logged: string[] = [];
const service = new TenantsService(collection, {
  domain: "clavix.test",
  onHostsChanged: (changed) => {
    hosts.push(changed);
  },
  log: (message) => logged.push(message),
});

// `clearDatabase` keeps `tenants` (the seed): a spec removes its own.
afterEach(async () => {
  hosts.length = 0;
  logged.length = 0;
  await collection.raw.deleteMany({ slug: { $ne: PLATFORM_TENANT_SLUG } });
});

describe("TenantsService onCreated", () => {
  test("is called with the new tenant's hex id; its failure is logged, the tenant stands", async () => {
    const created: string[] = [];
    const quiet: string[] = [];
    const ok = new TenantsService(collection, {
      domain: "clavix.test",
      onCreated: (id) => {
        created.push(id);
      },
    });
    const tenant = await ok.create({ slug: "acme", name: "Acme" });
    expect(created).toEqual([tenant._id.toHexString()]);

    const failing = new TenantsService(collection, {
      domain: "clavix.test",
      onCreated: () => {
        throw new Error("keys down");
      },
      log: (message) => quiet.push(message),
    });
    const other = await failing.create({ slug: "beta", name: "Beta" });
    expect(other.slug).toBe("beta");
    expect(quiet).toEqual([
      `tenants: onCreated failed for ${other._id.toHexString()}: keys down`,
    ]);
  });
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

  test("delete archives the tenant, reserves the slug and invalidates", async () => {
    const tenant = await service.create({ slug: "acme", name: "Acme" });
    hosts.length = 0;
    await service.delete(tenant._id);
    expect(await collection.findById(tenant._id)).toBeUndefined();
    expect(hosts).toEqual([["acme.clavix.test"]]);
    await expect(
      service.create({ slug: "acme", name: "Acme 2" }),
    ).rejects.toThrow(SlugTakenError);
    expect(hosts).toEqual([["acme.clavix.test"]]);
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

  test("failed creates and an empty name invalidate nothing", async () => {
    await expect(service.create({ slug: "www", name: "W" })).rejects.toThrow(
      InvalidSlugError,
    );
    await expect(
      service.create({ slug: PLATFORM_TENANT_SLUG, name: "Again" }),
    ).rejects.toThrow(SlugTakenError);
    await expect(service.create({ slug: "acme", name: "  " })).rejects.toThrow(
      TypeError,
    );
    expect(hosts).toEqual([]);
  });

  test("delete raises the version", async () => {
    const tenant = await service.create({ slug: "acme", name: "Acme" });
    const deleted = await service.delete(tenant._id);
    expect(deleted.version).toBeGreaterThan(tenant.version);
  });

  test("a hook that throws is logged and the write stands", async () => {
    const failing = new TenantsService(collection, {
      domain: "clavix.test",
      onHostsChanged: () => {
        throw new Error("redis down");
      },
      log: (message) => logged.push(message),
    });
    const tenant = await failing.create({ slug: "acme", name: "Acme" });
    expect((await failing.suspend(tenant._id)).status).toBe("suspended");
    expect(await collection.findById(tenant._id)).toMatchObject({
      status: "suspended",
    });
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("redis down");
  });

  test("a status change that races another write is re-read once, then fails", async () => {
    const tenant = await service.create({ slug: "acme", name: "Acme" });
    // One racing write after the first read: the retry reads again and wins.
    let raced = 0;
    const racing = {
      getById: async (id: never) => {
        const found = await collection.getById(id);
        if (raced++ === 0) await collection.update(found._id, { name: "B" });
        return found;
      },
      update: collection.update.bind(collection),
    } as unknown as typeof collection;
    const once = new TenantsService(racing, { domain: "clavix.test" });
    expect((await once.suspend(tenant._id)).status).toBe("suspended");
    // Two racing writes: the second conflict reaches the caller.
    raced = -1;
    const always = {
      getById: async (id: never) => {
        const found = await collection.getById(id);
        await collection.update(found._id, { name: `N${raced++}` });
        return found;
      },
      update: collection.update.bind(collection),
    } as unknown as typeof collection;
    await expect(
      new TenantsService(always, { domain: "clavix.test" }).reactivate(
        tenant._id,
      ),
    ).rejects.toThrow(OptimisticLockError);
  });

  test("the slug cannot change through update, updateMany or upsert", async () => {
    const tenant = await service.create({ slug: "acme", name: "Acme" });
    await expect(
      collection.update(tenant._id, { slug: "other" }),
    ).rejects.toThrow("immutable");
    await expect(
      collection.update(tenant._id, { $set: { slug: "other" } }),
    ).rejects.toThrow("immutable");
    await expect(
      collection.update(tenant._id, { $unset: { slug: "" } }),
    ).rejects.toThrow("immutable");
    await expect(
      collection.update(tenant._id, { $rename: { name: "slug" } }),
    ).rejects.toThrow("immutable");
    await expect(
      collection.updateMany({ slug: "acme" }, { slug: "other" }),
    ).rejects.toThrow("immutable");
    await expect(
      collection.upsert({ slug: "acme" }, { slug: "other" }),
    ).rejects.toThrow("immutable");
    expect(await collection.findById(tenant._id)).toMatchObject({
      slug: "acme",
    });
  });
});
