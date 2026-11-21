import { describe, expect, test } from "bun:test";
import type { LimitResult } from "@softistx/redis";
import {
  createMetadataThrottle,
  createRegisterThrottle,
  MetadataThrottledError,
  metadataLimits,
  RegisterThrottledError,
  registerLimits,
} from "./register-throttle";

const result = (allowed: boolean, retryAfter: number): LimitResult => ({
  allowed,
  limit: 10,
  remaining: allowed ? 9 : 0,
  resetAfter: retryAfter,
  retryAfter,
});
const ok = result(true, 0);
const refused = (ms: number) => result(false, ms);

function fakeLimits(ip: LimitResult | Error, tenant: LimitResult | Error) {
  const calls: string[] = [];
  const step = (name: string, result: LimitResult | Error) => ({
    consume: async (params: unknown) => {
      calls.push(`${name}:${JSON.stringify(params)}`);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { calls, ip: step("ip", ip), tenant: step("tenant", tenant) };
}

describe("createMetadataThrottle", () => {
  const build = (
    f: ReturnType<typeof fakeLimits>,
    log: (m: string) => void = () => {},
  ) =>
    createMetadataThrottle({ metadataIp: f.ip, metadataTenant: f.tenant }, log);

  test("counts the address, then the tenant", async () => {
    const f = fakeLimits(ok, ok);
    await build(f).check({ tenantId: "t1", ip: "1.2.3.4" });
    expect(f.calls).toEqual([
      'ip:{"tenantId":"t1","ip":"1.2.3.4"}',
      'tenant:{"tenantId":"t1"}',
    ]);
  });

  test("an unknown address shares one bucket", async () => {
    const f = fakeLimits(ok, ok);
    await build(f).check({ tenantId: "t1", ip: undefined });
    expect(f.calls[0]).toBe('ip:{"tenantId":"t1","ip":"unknown"}');
  });

  test("a refused address throws with Retry-After rounded up and spends no tenant budget", async () => {
    const f = fakeLimits(refused(2100), ok);
    const error = await build(f)
      .check({ tenantId: "t1", ip: "1.2.3.4" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(MetadataThrottledError);
    expect(error.retryAfter).toBe(3);
    expect(f.calls).toHaveLength(1);
  });

  test("a refused tenant throws, at least one second", async () => {
    const f = fakeLimits(ok, refused(10));
    const error = await build(f)
      .check({ tenantId: "t1", ip: "1.2.3.4" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(MetadataThrottledError);
    expect(error.retryAfter).toBe(1);
  });

  test("a Redis error lets the request through, logged", async () => {
    const f = fakeLimits(new Error("down"), ok);
    const logs: string[] = [];
    await build(f, (m) => logs.push(m)).check({ tenantId: "t1", ip: "x" });
    expect(logs).toEqual([
      "redis unavailable: metadata fetch limits skipped (connection failed)",
    ]);
  });
});

describe("createRegisterThrottle", () => {
  test("refuses with its own error", async () => {
    const f = fakeLimits(ok, refused(5000));
    const throttle = createRegisterThrottle(
      {
        registerIp: f.ip,
        registerTenant: f.tenant,
      },
      () => {},
    );
    const error = await throttle
      .check({ tenantId: "t1", ip: "x" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(RegisterThrottledError);
    expect(error.retryAfter).toBe(5);
  });
});

describe("the limit definitions", () => {
  const config = {
    ipLimit: 7,
    ipWindowSeconds: 60,
    tenantLimit: 70,
    tenantWindowSeconds: 600,
  };
  test("metadataLimits names the pair and keys it by tenant", () => {
    const { metadataIp, metadataTenant } = metadataLimits(config);
    expect(metadataIp.name).toBe("metadata-ip");
    expect(metadataTenant.name).toBe("metadata-tenant");
    expect(metadataIp.key({ tenantId: "t", ip: "1.1.1.1" })).toBe("t/1.1.1.1");
    expect(metadataTenant.key({ tenantId: "t" })).toBe("t");
    expect(metadataIp.limit).toBe(7);
    expect(metadataIp.per).toBe(60_000);
    expect(metadataTenant.limit).toBe(70);
    expect(metadataTenant.per).toBe(600_000);
  });
  test("registerLimits uses its own names", () => {
    const { registerIp, registerTenant } = registerLimits(config);
    expect(registerIp.name).toBe("register-ip");
    expect(registerTenant.name).toBe("register-tenant");
  });
});
