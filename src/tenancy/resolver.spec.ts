import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { createTenantResolver, type TenantRecord } from "./resolver";
import { memoryTenantCache, type TenantCache } from "./tenant-cache";

const config = {
  scheme: "https",
  domain: "clavix.test",
  port: undefined,
} as const;

function setup(
  records: TenantRecord[],
  cache: TenantCache = memoryTenantCache(),
) {
  const lookups: string[] = [];
  const logged: string[] = [];
  const resolver = createTenantResolver({
    lookup: async (slug) => {
      lookups.push(slug);
      return records.find((r) => r.slug === slug);
    },
    cache,
    config,
    log: (m) => logged.push(m),
  });
  return { resolver, lookups, logged, records };
}

const acme: TenantRecord = {
  _id: new ObjectId(),
  slug: "acme",
  status: "active",
  version: 3,
};

describe("resolveHost", () => {
  test("an active tenant resolves to plain data", async () => {
    const { resolver } = setup([acme]);
    expect(await resolver.resolveHost("Acme.clavix.test:8443")).toEqual({
      tenantId: acme._id.toHexString(),
      slug: "acme",
      issuer: "https://acme.clavix.test",
      partition: acme._id.toHexString(),
      version: 3,
    });
  });

  test("the issuer carries a configured scheme and port", async () => {
    const resolver = createTenantResolver({
      lookup: async () => acme,
      cache: memoryTenantCache(),
      config: { scheme: "http", domain: "clavix.test", port: 3000 },
    });
    expect((await resolver.resolveHost("acme.clavix.test"))?.issuer).toBe(
      "http://acme.clavix.test:3000",
    );
  });

  test("a hit is cached: Mongo is read once", async () => {
    const { resolver, lookups } = setup([acme]);
    await resolver.resolveHost("acme.clavix.test");
    await resolver.resolveHost("ACME.clavix.test:1");
    expect(lookups).toEqual(["acme"]);
  });

  test("a hit is stored for 600 s, none for 30 s", async () => {
    const stored: [string, unknown, number][] = [];
    const cache: TenantCache = {
      ...memoryTenantCache(),
      get: async () => undefined,
      set: (host, value, ttl) => {
        stored.push([host, value, ttl]);
      },
    };
    const { resolver } = setup([acme], cache);
    await resolver.resolveHost("acme.clavix.test");
    await resolver.resolveHost("ghost.clavix.test");
    expect(stored.map(([h, v, ttl]) => [h, v === null, ttl])).toEqual([
      ["acme.clavix.test", false, 600],
      ["ghost.clavix.test", true, 30],
    ]);
  });

  test("an unknown slug is null, and the null is cached", async () => {
    const { resolver, lookups } = setup([]);
    expect(await resolver.resolveHost("ghost.clavix.test")).toBeNull();
    expect(await resolver.resolveHost("ghost.clavix.test")).toBeNull();
    expect(lookups).toEqual(["ghost"]);
  });

  test("the null expires after 30 s", async () => {
    let now = 0;
    const { resolver, lookups, records } = setup(
      [],
      memoryTenantCache(() => now),
    );
    expect(await resolver.resolveHost("acme.clavix.test")).toBeNull();
    records.push(acme);
    now = 29_000;
    expect(await resolver.resolveHost("acme.clavix.test")).toBeNull();
    now = 30_001;
    expect(await resolver.resolveHost("acme.clavix.test")).not.toBeNull();
    expect(lookups).toEqual(["acme", "acme"]);
  });

  test("a suspended tenant is null", async () => {
    const { resolver } = setup([{ ...acme, status: "suspended" }]);
    expect(await resolver.resolveHost("acme.clavix.test")).toBeNull();
  });

  test("hosts that cannot be a tenant never reach the cache or Mongo", async () => {
    const { resolver, lookups } = setup([acme]);
    for (const host of [
      "clavix.test",
      "www.clavix.test",
      "a.acme.clavix.test",
      "127.0.0.1",
      "acme.other.test",
    ]) {
      expect(await resolver.resolveHost(host)).toBeNull();
    }
    expect(lookups).toEqual([]);
  });

  test("a Redis failure is logged and Mongo is read", async () => {
    const broken: TenantCache = {
      get: async () => {
        throw new Error("down");
      },
      set: async () => {
        throw new Error("down");
      },
      delete: async () => {},
    };
    const { resolver, logged } = setup([acme], broken);
    expect((await resolver.resolveHost("acme.clavix.test"))?.slug).toBe("acme");
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("cache read failed for acme.clavix.test");
  });
});

describe("resolveRequest", () => {
  test("uses the URL's host and ignores X-Forwarded-Host", async () => {
    const { resolver } = setup([
      acme,
      { ...acme, _id: new ObjectId(), slug: "evil" },
    ]);
    const request = new Request("https://acme.clavix.test/oauth", {
      headers: { "x-forwarded-host": "evil.clavix.test" },
    });
    expect((await resolver.resolveRequest(request))?.slug).toBe("acme");
  });
});

describe("invalidate", () => {
  test("drops the hosts, so the next read sees the change", async () => {
    const { resolver, records } = setup([acme]);
    await resolver.resolveHost("acme.clavix.test");
    records[0] = { ...acme, status: "suspended", version: 4 };
    expect((await resolver.resolveHost("acme.clavix.test"))?.version).toBe(3);
    await resolver.invalidate(["Acme.clavix.test"]);
    expect(await resolver.resolveHost("acme.clavix.test")).toBeNull();
  });
});
