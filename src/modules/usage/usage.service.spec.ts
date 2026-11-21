import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { agentClientsService } from "@/config/agent-clients";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { usageService } from "@/config/usage";
import { registerClient } from "@/modules/clients";
import { PLATFORM_TENANT_SLUG, TenantsService } from "@/modules/tenants";
import { QuotaExceededError } from "./usage.errors";
import { assertWithinQuota } from "./usage.rules";
import { UsageService } from "./usage.service";

const tenant = (plan: "free" | "pro" | "enterprise" = "free") => ({
  _id: new ObjectId(),
  plan,
  quotaOverrides: {},
});

type Counter = ConstructorParameters<typeof UsageService>[2];
function fakeCounter() {
  const seen = new Map<string, Set<string>>();
  const counter = {
    add: async (key: { tenantId: string; month: string }, id: string) => {
      const k = `${key.tenantId}:${key.month}`;
      seen.set(k, (seen.get(k) ?? new Set()).add(id));
    },
    count: async (key: { tenantId: string; month: string }) =>
      seen.get(`${key.tenantId}:${key.month}`)?.size ?? 0,
  };
  return counter as unknown as Counter;
}

const logged: string[] = [];
const sources = {
  clients: async () => 2,
  domains: async () => 0,
  agents: async () => 0,
  webhooks: async () => 0,
  connections: async () => 0,
};
const at = new Date("2026-11-12T12:00:00Z");
const make = (mau: Counter) =>
  new UsageService(
    mongo.db.usageCounters,
    sources,
    mau,
    (m) => logged.push(m),
    () => at,
  );

beforeEach(() => {
  logged.length = 0;
});
afterAll(async () => {
  await mongo.db.usageCounters.raw.deleteMany({});
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
});

describe("UsageService", () => {
  test("counts a user once a month and reports the meters against the plan", async () => {
    const service = make(fakeCounter());
    const t = tenant();
    const id = t._id.toHexString();
    for (const user of ["a", "b", "a", "c"])
      await service.recordActive(id, user);
    const report = await service.report(t);
    expect(report.month).toBe("2026-11");
    expect(report.mau).toEqual({ used: 3, quota: 1000, exceeded: false });
    expect(report.clients).toEqual({ used: 2, quota: 3, exceeded: false });
    expect(report.domains).toEqual({ used: 0, quota: 1, exceeded: false });
  });

  test("flags a meter past its quota, and an override replaces the plan's", async () => {
    const service = make(fakeCounter());
    const t = { ...tenant(), quotaOverrides: { mau: 1, clients: 1 } };
    const id = t._id.toHexString();
    await service.recordActive(id, "a");
    await service.recordActive(id, "b");
    const report = await service.report(t);
    expect(report.mau).toEqual({ used: 2, quota: 1, exceeded: true });
    expect(report.clients.exceeded).toBe(true);
  });

  test("enterprise has no limit", async () => {
    const report = await make(fakeCounter()).report(tenant("enterprise"));
    expect(report.mau.quota).toBeNull();
    expect(report.mau.exceeded).toBe(false);
  });

  test("keeps a month's count once read, even if the counter later forgets it", async () => {
    const counter = fakeCounter();
    const service = make(counter);
    const t = tenant();
    const id = t._id.toHexString();
    await service.recordActive(id, "a");
    await service.recordActive(id, "b");
    expect((await service.report(t)).mau.used).toBe(2);
    const stored = await scopeToTenant(mongo.db.usageCounters, t._id).findFirst(
      {
        month: "2026-11",
      },
    );
    expect(stored?.mau).toBe(2);
    // A counter that expired: the stored snapshot answers.
    expect((await make(fakeCounter()).report(t)).mau.used).toBe(2);
    // A month never counted reads 0.
    expect((await service.report(t, "2026-01")).mau.used).toBe(0);
  });

  test("recordActive never throws, and reading falls back on the snapshot", async () => {
    const broken = {
      add: async () => {
        throw new Error("redis down");
      },
      count: async () => {
        throw new Error("redis down");
      },
    } as unknown as Counter;
    const service = make(broken);
    await service.recordActive("65f0000000000000000000aa", "u");
    expect(logged[0]).toContain("redis down");
    expect((await service.report(tenant())).mau.used).toBe(0);
    // Without Redis nothing is counted.
    await make(undefined).recordActive("x", "u");
  });
});

describe("hard quotas", () => {
  test("assertWithinQuota refuses at the quota, not before; null passes", () => {
    expect(() => assertWithinQuota("clients", 2, 3)).not.toThrow();
    expect(() => assertWithinQuota("clients", 3, 3)).toThrow(
      QuotaExceededError,
    );
    expect(() => assertWithinQuota("domains", 99, null)).not.toThrow();
    try {
      assertWithinQuota("domains", 1, 1);
    } catch (error) {
      expect(error).toMatchObject({ key: "domains", quota: 1 });
    }
  });
});

describe("the clients count over the real OAuth store", () => {
  test("counts a tenant's registered clients and no other tenant's", async () => {
    const service = new TenantsService(mongo.db.tenants, {
      now: () => new Date(),
      log: () => {},
      domain: "clavix.test",
    });
    const a = await service.create({ slug: "usea", name: "A" });
    const b = await service.create({ slug: "useb", name: "B" });
    const options = {
      db: oauthDb,
      findTenant: (slug: string) => mongo.db.tenants.findFirst({ slug }),
      now: () => new Date(),
    };
    const redirect = "https://app.example/callback";
    await registerClient(options, {
      tenant: "usea",
      name: "One",
      redirectUris: [redirect],
    });
    await registerClient(options, {
      tenant: "usea",
      name: "Two",
      redirectUris: [redirect],
    });
    await registerClient(options, {
      tenant: "useb",
      name: "Other",
      redirectUris: [redirect],
    });
    expect(await usageService.count(a._id.toHexString(), "clients")).toBe(2);
    expect(await usageService.count(b._id.toHexString(), "clients")).toBe(1);
    expect(
      await usageService.count(new ObjectId().toHexString(), "clients"),
    ).toBe(0);
    expect(await usageService.count(a._id.toHexString(), "domains")).toBe(0);
  });
  test("agents are not clients: dynamic agents leave the clients count and fill the agents count", async () => {
    const service = new TenantsService(mongo.db.tenants, {
      now: () => new Date(),
      log: () => {},
      domain: "clavix.test",
    });
    const t = await service.create({ slug: "usec", name: "C" });
    const id = t._id.toHexString();
    const options = {
      db: oauthDb,
      findTenant: (slug: string) => mongo.db.tenants.findFirst({ slug }),
      now: () => new Date(),
    };
    const redirect = "https://app.example/callback";
    await registerClient(options, {
      tenant: "usec",
      name: "Console",
      redirectUris: [redirect],
    });
    const agent = await registerClient(options, {
      tenant: "usec",
      name: "Agent",
      redirectUris: [redirect],
    });
    await agentClientsService.record(id, {
      clientId: agent.clientId,
      kind: "dynamic",
    });
    expect(await usageService.count(id, "clients")).toBe(1);
    expect(await usageService.count(id, "agents")).toBe(1);
  });
});
