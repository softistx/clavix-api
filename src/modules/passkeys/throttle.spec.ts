import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { startTestRedis, type TestRedis } from "@softistx/redis/testing";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { openAppRedis } from "@/config/redis";
import { tenantResolver } from "@/config/tenancy";
import { createSignInThrottle } from "@/modules/auth/throttle";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import { createPasskeyThrottle, type PasskeyLimitConfig } from "./throttle";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const service = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});

let server: TestRedis;
beforeAll(async () => {
  server = await startTestRedis();
  await service.create({ slug: "lima", name: "Lima" });
  await service.create({ slug: "mike", name: "Mike" });
}, 300_000);
afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await server?.stop();
});
beforeEach(() => server.reset());

const OPTIONS = `mutation { passkeySignInOptions { challenge } }`;

type Answer = {
  response: Response;
  error: { extensions: Record<string, unknown> } | undefined;
};

async function post(
  app: ReturnType<typeof createApp>,
  slug: string,
  ip: string,
  query: string,
): Promise<Answer> {
  const issuer = issuerOf(slug, origin);
  const response = await app.request(`${issuer}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: issuer.replace(/\/$/, ""),
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ query }),
  });
  const body = (await response.json()) as {
    errors?: { extensions: Record<string, unknown> }[];
  };
  return { response, error: body.errors?.[0] };
}

async function setup(limits: PasskeyLimitConfig) {
  const redis = await openAppRedis(server.uri, () => {}, undefined, limits);
  for (let i = 0; i < 100; i += 1) {
    const ready = await redis.limits.passkeyIp
      .peek({ tenantId: "ready", ip: "0.0.0.0" }, 0)
      .then(
        () => true,
        () => false,
      );
    if (ready) break;
    await Bun.sleep(20);
  }
  const app = createApp({
    passkeyThrottle: createPasskeyThrottle(redis.limits, (message) => {
      throw new Error(message); // a spec never runs with Redis down
    }),
  });
  return {
    ask: (slug: string, ip: string) => post(app, slug, ip, OPTIONS),
    close: () => redis.close(),
    redis,
  };
}

const roomy = 1_000;
const base: PasskeyLimitConfig = {
  ipLimit: roomy,
  ipWindowSeconds: 600,
  tenantLimit: roomy,
  tenantWindowSeconds: 3600,
};

describe("unknown host", () => {
  test("is NOT_FOUND and spends no throttle budget", async () => {
    let checks = 0;
    const app = createApp({
      passkeyThrottle: {
        check: async () => {
          checks += 1;
        },
      },
    });
    const host = `http://nobody-here.${env.CLAVIX_DOMAIN}`;
    const response = await app.request(`${host}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: host },
      body: JSON.stringify({ query: OPTIONS }),
    });
    const body = (await response.json()) as {
      errors?: { extensions: Record<string, unknown> }[];
    };
    expect(body.errors?.[0]?.extensions["code"]).toBe("NOT_FOUND");
    expect(checks).toBe(0);
  });
});

describe("per client address", () => {
  test("the request past the limit is PASSKEY_THROTTLED, 429, with Retry-After", async () => {
    const { ask, close } = await setup({ ...base, ipLimit: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect((await ask("lima", "203.0.113.1")).error).toBeUndefined();
    }
    const { response, error } = await ask("lima", "203.0.113.1");
    expect(response.status).toBe(429);
    expect(error?.extensions["code"]).toBe("PASSKEY_THROTTLED");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    await close();
  });

  test("another address, and the same address on another tenant, have their own budget", async () => {
    const { ask, close } = await setup({ ...base, ipLimit: 2 });
    await ask("lima", "203.0.113.1");
    await ask("lima", "203.0.113.1");
    expect((await ask("lima", "203.0.113.1")).response.status).toBe(429);
    expect((await ask("lima", "203.0.113.2")).error).toBeUndefined();
    expect((await ask("mike", "203.0.113.1")).error).toBeUndefined();
    await close();
  });

  test("a denied address does not spend the tenant's budget", async () => {
    const { ask, close } = await setup({ ...base, ipLimit: 1, tenantLimit: 2 });
    for (let i = 0; i < 5; i += 1) await ask("lima", "203.0.113.1");
    expect((await ask("lima", "203.0.113.2")).error).toBeUndefined();
    expect((await ask("lima", "203.0.113.3")).response.status).toBe(429);
    await close();
  });
});

describe("per tenant", () => {
  test("the request past the limit is PASSKEY_THROTTLED, 429, from any address", async () => {
    const { ask, close } = await setup({ ...base, tenantLimit: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect((await ask("lima", `198.51.100.${i}`)).error).toBeUndefined();
    }
    const { response, error } = await ask("lima", "198.51.100.99");
    expect(response.status).toBe(429);
    expect(error?.extensions["code"]).toBe("PASSKEY_THROTTLED");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    await close();
  });

  test("tenant A's traffic never spends tenant B's budget", async () => {
    const { ask, close } = await setup({ ...base, tenantLimit: 2 });
    await ask("lima", "198.51.100.1");
    await ask("lima", "198.51.100.2");
    expect((await ask("lima", "198.51.100.3")).response.status).toBe(429);
    expect((await ask("mike", "198.51.100.1")).error).toBeUndefined();
    expect((await ask("mike", "198.51.100.2")).error).toBeUndefined();
    expect((await ask("mike", "198.51.100.3")).response.status).toBe(429);
    await close();
  });
});

describe("separate from the sign-in code limits", () => {
  test("spending the passkey budget leaves requestSignInCode's alone", async () => {
    const { ask, close, redis } = await setup({ ...base, ipLimit: 1 });
    await ask("lima", "203.0.113.1");
    expect((await ask("lima", "203.0.113.1")).response.status).toBe(429);
    const signIn = createSignInThrottle(redis.limits, () => {});
    await signIn.check({ tenantId: "t", ip: "203.0.113.1" });
    await close();
  });
});

describe("Redis down", () => {
  test("the request goes through, logged", async () => {
    const redis = await openAppRedis(server.uri, () => {}, undefined, base);
    const logs: string[] = [];
    const throttle = createPasskeyThrottle(redis.limits, (m) => logs.push(m));
    await redis.close();
    await throttle.check({ tenantId: "t", ip: "203.0.113.9" });
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("passkey sign-in limits");
  });
});
