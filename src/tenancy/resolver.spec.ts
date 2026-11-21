import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { oauthPolicySchema } from "@/modules/oauth-policy/oauth-policy.schema";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import { isLive } from "./resolved-tenant";
import { createTenantResolver, type TenantRecord } from "./resolver";
import { memoryTenantCache, type TenantCache } from "./tenant-cache";

const config = {
  scheme: "https",
  domain: "clavix.test",
  port: undefined,
} as const;

function setup(
  records: TenantRecord[],
  cache: TenantCache = memoryTenantCache(Date.now),
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
  name: "Acme",
  signUp: false,
  status: "active",
  version: 3,
  signIn: signInPolicySchema.parse(undefined),
  oauth: oauthPolicySchema.parse(undefined),
};

describe("resolveHost", () => {
  test("an active tenant resolves to plain data", async () => {
    const { resolver } = setup([acme]);
    expect(await resolver.resolveHost("Acme.clavix.test:8443")).toEqual({
      tenantId: acme._id.toHexString(),
      slug: "acme",
      name: "Acme",
      signUp: false,
      status: "active",
      issuer: "https://acme.clavix.test",
      slugIssuer: "https://acme.clavix.test",
      relatedOrigins: [],
      plan: "free",
      partition: acme._id.toHexString(),
      version: 3,
      signIn: acme.signIn,
      oauth: acme.oauth,
    });
  });

  test("the issuer carries a configured scheme and port", async () => {
    const resolver = createTenantResolver({
      lookup: async () => acme,
      cache: memoryTenantCache(Date.now),
      config: { scheme: "http", domain: "clavix.test", port: 3000 },
      log: () => {},
    });
    expect((await resolver.resolveHost("acme.clavix.test"))?.issuer).toBe(
      "http://acme.clavix.test:3000",
    );
  });

  test("a hit is cached: a second host read does not read Mongo", async () => {
    const { resolver, lookups } = setup([acme]);
    await resolver.resolveHost("acme.clavix.test");
    // The miss read the tenant, and read its version again after the set.
    expect(lookups).toEqual(["acme", "acme"]);
    await resolver.resolveHost("ACME.clavix.test:1");
    expect(lookups).toEqual(["acme", "acme"]);
  });

  test("a hit is stored for 60 s, none for 30 s", async () => {
    const stored: [string, unknown, number][] = [];
    const cache: TenantCache = {
      ...memoryTenantCache(Date.now),
      get: async () => undefined,
      set: (host, value, ttl) => {
        stored.push([host, value, ttl]);
      },
    };
    const { resolver } = setup([acme], cache);
    await resolver.resolveHost("acme.clavix.test");
    await resolver.resolveHost("ghost.clavix.test");
    expect(stored.map(([h, v, ttl]) => [h, v === null, ttl])).toEqual([
      ["acme.clavix.test", false, 60],
      ["ghost.clavix.test", true, 30],
    ]);
  });

  test("an unknown slug is null, and the null is cached", async () => {
    const { resolver, lookups } = setup([]);
    expect(await resolver.resolveHost("ghost.clavix.test")).toBeNull();
    expect(lookups).toEqual(["ghost", "ghost"]);
    expect(await resolver.resolveHost("ghost.clavix.test")).toBeNull();
    expect(lookups).toEqual(["ghost", "ghost"]);
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
    expect(lookups).toEqual(["acme", "acme", "acme", "acme"]);
  });

  test("a suspended or deleted tenant resolves with its status; one being purged is null", async () => {
    const paused = setup([{ ...acme, status: "suspended" }]);
    expect(
      (await paused.resolver.resolveHost("acme.clavix.test"))?.status,
    ).toBe("suspended");
    const trashed = setup([{ ...acme, deletedAt: new Date() }]);
    const resolved = await trashed.resolver.resolveHost("acme.clavix.test");
    expect(resolved?.status).toBe("deleted");
    expect(resolved && isLive(resolved)).toBe(false);
    const purging = setup([
      { ...acme, deletedAt: new Date(), purgeStartedAt: new Date() },
    ]);
    expect(await purging.resolver.resolveHost("acme.clavix.test")).toBeNull();
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
    expect((await resolver.resolveHost("acme.clavix.test"))?.status).toBe(
      "suspended",
    );
  });
});

describe("cache-aside race", () => {
  test("a suspension between the read and the set does not leave a stale entry", async () => {
    const records: TenantRecord[] = [acme];
    const inner = memoryTenantCache(Date.now);
    let resolver: ReturnType<typeof createTenantResolver>;
    let raced = false;
    const cache: TenantCache = {
      ...inner,
      // The interleaving: lookup (active) / suspend + invalidate / set.
      set: async (host, value, ttl) => {
        if (!raced) {
          raced = true;
          records[0] = { ...acme, status: "suspended", version: 4 };
          await resolver.invalidate([host]);
        }
        await inner.set(host, value, ttl);
      },
    };
    resolver = createTenantResolver({
      lookup: async (slug) => records.find((r) => r.slug === slug),
      cache,
      config,
      log: () => {},
    });
    // This caller read the tenant before the suspension: it may answer with it.
    expect((await resolver.resolveHost("acme.clavix.test"))?.version).toBe(3);
    // The stale entry did not survive: the next caller sees the suspension.
    expect(await inner.get("acme.clavix.test")).toBeUndefined();
    expect((await resolver.resolveHost("acme.clavix.test"))?.status).toBe(
      "suspended",
    );
  });

  test("a creation between the read and the set drops the cached null", async () => {
    const records: TenantRecord[] = [];
    const inner = memoryTenantCache(Date.now);
    let raced = false;
    const cache: TenantCache = {
      ...inner,
      set: async (host, value, ttl) => {
        if (!raced) {
          raced = true;
          records.push(acme);
        }
        await inner.set(host, value, ttl);
      },
    };
    const resolver = createTenantResolver({
      lookup: async (slug) => records.find((r) => r.slug === slug),
      cache,
      config,
      log: () => {},
    });
    expect(await resolver.resolveHost("acme.clavix.test")).toBeNull();
    expect((await resolver.resolveHost("acme.clavix.test"))?.slug).toBe("acme");
  });
});

describe("invalidate failure", () => {
  test("a failed delete is retried once", async () => {
    let calls = 0;
    const cache: TenantCache = {
      ...memoryTenantCache(Date.now),
      delete: async () => {
        calls++;
        if (calls === 1) throw new Error("down");
      },
    };
    const { resolver } = setup([acme], cache);
    await resolver.invalidate(["acme.clavix.test"]);
    expect(calls).toBe(2);
  });

  test("two failures reach the caller", async () => {
    const cache: TenantCache = {
      ...memoryTenantCache(Date.now),
      delete: async () => {
        throw new Error("down");
      },
    };
    const { resolver } = setup([acme], cache);
    await expect(resolver.invalidate(["acme.clavix.test"])).rejects.toThrow(
      "down",
    );
  });
});

describe("custom domains", () => {
  function withDomains(
    record: TenantRecord,
    verified: Record<string, ObjectId>,
    primary?: string,
  ) {
    return createTenantResolver({
      lookup: async (slug) => (slug === record.slug ? record : undefined),
      lookupById: async (id) => (id.equals(record._id) ? record : undefined),
      domains: {
        tenantOfHost: async (host) => verified[host],
        primaryHostOf: async () => primary,
        verifiedHostsOf: async () => [],
      },
      cache: memoryTenantCache(Date.now),
      config,
      log: () => {},
    });
  }

  test("a verified host resolves to its tenant; the issuer stays the slug host without a primary", async () => {
    const resolver = withDomains(acme, { "auth.acme.com": acme._id });
    const resolved = await resolver.resolveHost("Auth.Acme.com");
    expect(resolved?.tenantId).toBe(acme._id.toHexString());
    expect(resolved?.issuer).toBe("https://acme.clavix.test");
  });

  test("the issuer follows the primary host while the slug host stays the passkey issuer", async () => {
    const resolver = withDomains(
      acme,
      { "auth.acme.com": acme._id },
      "auth.acme.com",
    );
    for (const host of ["auth.acme.com", "acme.clavix.test"]) {
      const resolved = await resolver.resolveHost(host);
      expect(resolved?.issuer).toBe("https://auth.acme.com");
      expect(resolved?.slugIssuer).toBe("https://acme.clavix.test");
    }
  });

  test("carries the origins of the tenant's verified domains (ADR-0036), none without a directory", async () => {
    const resolver = createTenantResolver({
      lookup: async () => acme,
      domains: {
        tenantOfHost: async () => undefined,
        primaryHostOf: async () => undefined,
        verifiedHostsOf: async () => ["login.acme.test", "auth.acme.com"],
      },
      cache: memoryTenantCache(Date.now),
      config,
      log: () => {},
    });
    const resolved = await resolver.resolveHost("acme.clavix.test");
    expect(resolved?.relatedOrigins).toEqual([
      "https://login.acme.test",
      "https://auth.acme.com",
    ]);
    const plain = setup([acme]).resolver;
    expect(
      (await plain.resolveHost("acme.clavix.test"))?.relatedOrigins,
    ).toEqual([]);
  });

  test("a suspended tenant's custom host resolves but is not live", async () => {
    const suspended = { ...acme, status: "suspended" as const };
    const resolver = withDomains(suspended, { "auth.acme.com": acme._id });
    const resolved = await resolver.resolveHost("auth.acme.com");
    expect(resolved).toBeDefined();
    expect(resolved && isLive(resolved)).toBe(false);
  });

  test("an unknown host, or one under the apex that is no slug, resolves to nothing", async () => {
    const resolver = withDomains(acme, { "auth.acme.com": acme._id });
    expect(await resolver.resolveHost("other.example.org")).toBeNull();
    expect(await resolver.resolveHost("a_b.clavix.test")).toBeNull();
  });
});
