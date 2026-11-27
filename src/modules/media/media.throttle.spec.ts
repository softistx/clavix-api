import { describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import type { LimitResult } from "@softistx/redis";
import { avatarLimits, createAvatarThrottle } from "./media.throttle";

const result = (allowed: boolean, retryAfter: number): LimitResult => ({
  allowed,
  limit: 10,
  remaining: 0,
  resetAfter: retryAfter,
  retryAfter,
});
const allowed = result(true, 0);
const WHO = { tenantId: "t1", userId: "u1", ip: "198.51.100.9" };

const limitsOf = (
  results: Partial<Record<"user" | "ip" | "tenant", LimitResult>>,
  spent: string[] = [],
) => ({
  avatarUser: {
    consume: async () => {
      spent.push("user");
      return results.user ?? allowed;
    },
  },
  avatarIp: {
    consume: async () => {
      spent.push("ip");
      return results.ip ?? allowed;
    },
  },
  avatarTenant: {
    consume: async () => {
      spent.push("tenant");
      return results.tenant ?? allowed;
    },
  },
});

describe("avatarLimits", () => {
  test("names the three limits of an upload", () => {
    const limits = avatarLimits({
      userLimit: 10,
      userWindowSeconds: 3600,
      ipLimit: 30,
      ipWindowSeconds: 3600,
      tenantLimit: 1000,
      tenantWindowSeconds: 3600,
    });
    expect(Object.keys(limits).sort()).toEqual([
      "avatarIp",
      "avatarTenant",
      "avatarUser",
    ]);
  });
});

describe("createAvatarThrottle", () => {
  test("an upload within every budget goes through", async () => {
    const spent: string[] = [];
    await createAvatarThrottle(limitsOf({}, spent), () => {}).check(WHO);
    expect(spent).toEqual(["user", "ip", "tenant"]);
  });

  test("a refused user is a throttled refusal with the wait, and spends no other budget", async () => {
    const spent: string[] = [];
    const throttle = createAvatarThrottle(
      limitsOf({ user: result(false, 90_500) }, spent),
      () => {},
    );
    const error = await throttle.check(WHO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaRefusal);
    expect(error).toMatchObject({
      code: "throttled",
      details: { retryAfter: 91 },
    });
    expect(spent).toEqual(["user"]);
  });

  test("a refused address or tenant is refused too", async () => {
    for (const which of ["ip", "tenant"] as const) {
      const throttle = createAvatarThrottle(
        limitsOf({ [which]: result(false, 500) }),
        () => {},
      );
      expect(await throttle.check(WHO).catch((e: unknown) => e)).toMatchObject({
        code: "throttled",
        details: { retryAfter: 1 },
      });
    }
  });

  test("Redis down lets the upload through and logs it", async () => {
    const logged: string[] = [];
    const down = {
      consume: async (): Promise<LimitResult> => {
        throw new Error("down");
      },
    };
    await createAvatarThrottle(
      { avatarUser: down, avatarIp: down, avatarTenant: down },
      (message) => logged.push(message),
    ).check(WHO);
    expect(logged.length).toBeGreaterThan(0);
  });
});
