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
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import { clientHeaders } from "~/client-header";
import { quietTenants } from "~/ports";
import { settled } from "./auth.outbox";
import { createSignInThrottle, type SignInLimitConfig } from "./auth.throttle";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const service = new TenantsService(mongo.db.tenants, {
  ...quietTenants,
  now: () => new Date(),
  log: () => {},
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});

let server: TestRedis;
beforeAll(async () => {
  server = await startTestRedis();
  await service.create({ slug: "lima", name: "Lima", signUp: true });
  await service.create({ slug: "mike", name: "Mike", signUp: true });
}, 300_000);
afterAll(async () => {
  await settled();
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await server?.stop();
});
beforeEach(() => server.reset());

const REQUEST = `mutation ($email: EmailAddress!) {
  requestSignInCode(email: $email) { challenge }
}`;
let counter = 0;
const nextEmail = () => {
  counter += 1;
  return `user${counter}@example.test`;
};

// An app over a Redis with the given limits; `ask` is a sign-in code request
// for a tenant, from a client address (the one proxy in front writes it).
async function setup(limits: SignInLimitConfig) {
  const redis = await openAppRedis(server.uri, () => {}, limits);
  // The client connects in the background: wait until it answers, or the
  // first requests would fail open.
  for (let i = 0; i < 100; i += 1) {
    const ready = await redis.limits.signInIp
      .peek({ tenantId: "ready", ip: "0.0.0.0" }, 0)
      .then(
        () => true,
        () => false,
      );
    if (ready) break;
    await Bun.sleep(20);
  }
  const app = createApp({
    signInThrottle: createSignInThrottle(redis.limits, (message) => {
      throw new Error(message); // a spec never runs with Redis down
    }),
  });
  const ask = async (slug: string, ip: string, email = nextEmail()) => {
    const response = await app.request(`${issuerOf(slug, origin)}/graphql`, {
      method: "POST",
      headers: {
        ...clientHeaders,
        "content-type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ query: REQUEST, variables: { email } }),
    });
    const body = (await response.json()) as {
      errors?: { message: string; extensions: Record<string, unknown> }[];
    };
    return { response, error: body.errors?.[0] };
  };
  return { ask, close: () => redis.close() };
}

const roomy = 1_000;
const base: SignInLimitConfig = {
  ipLimit: roomy,
  ipWindowSeconds: 600,
  tenantLimit: roomy,
  tenantWindowSeconds: 3600,
};

describe("per client address", () => {
  test("the request past the limit is MAIL_THROTTLED, 429, with Retry-After", async () => {
    const { ask, close } = await setup({ ...base, ipLimit: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect((await ask("lima", "203.0.113.1")).error).toBeUndefined();
    }
    const { response, error } = await ask("lima", "203.0.113.1");
    expect(response.status).toBe(429);
    expect(error?.extensions["code"]).toBe("MAIL_THROTTLED");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    await close();
  });

  test("another address has its own budget", async () => {
    const { ask, close } = await setup({ ...base, ipLimit: 2 });
    await ask("lima", "203.0.113.1");
    await ask("lima", "203.0.113.1");
    expect((await ask("lima", "203.0.113.1")).response.status).toBe(429);
    expect((await ask("lima", "203.0.113.2")).error).toBeUndefined();
    await close();
  });

  test("the same address on another tenant has its own budget", async () => {
    const { ask, close } = await setup({ ...base, ipLimit: 2 });
    await ask("lima", "203.0.113.1");
    await ask("lima", "203.0.113.1");
    expect((await ask("lima", "203.0.113.1")).response.status).toBe(429);
    expect((await ask("mike", "203.0.113.1")).error).toBeUndefined();
    await close();
  });

  test("a denied address does not spend the tenant's budget", async () => {
    const { ask, close } = await setup({ ...base, ipLimit: 1, tenantLimit: 2 });
    await ask("lima", "203.0.113.1");
    for (let i = 0; i < 5; i += 1) await ask("lima", "203.0.113.1");
    expect((await ask("lima", "203.0.113.2")).error).toBeUndefined();
    expect((await ask("lima", "203.0.113.3")).response.status).toBe(429);
    await close();
  });
});

describe("per tenant", () => {
  test("the request past the limit is MAIL_THROTTLED, 429, from any address", async () => {
    const { ask, close } = await setup({ ...base, tenantLimit: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect((await ask("lima", `198.51.100.${i}`)).error).toBeUndefined();
    }
    const { response, error } = await ask("lima", "198.51.100.99");
    expect(response.status).toBe(429);
    expect(error?.extensions["code"]).toBe("MAIL_THROTTLED");
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

describe("the answer", () => {
  test("has the shape of the per-address throttle", async () => {
    const { ask, close } = await setup({ ...base, ipLimit: 1 });
    // janus: 5 mails per address per 10 min; the sixth is MAIL_THROTTLED.
    const email = "same@example.test";
    let perAddress: Awaited<ReturnType<typeof ask>> | undefined;
    for (let i = 0; i < 6; i += 1)
      perAddress = await ask("mike", `192.0.2.${i}`, email);
    await settled();
    const perIp = await ask("lima", "192.0.2.200");
    const refused = await ask("lima", "192.0.2.200");
    expect(perIp.error).toBeUndefined();
    expect(perAddress?.response.status).toBe(429);
    expect(refused.response.status).toBe(429);
    expect(refused.error?.message).toBe(perAddress?.error?.message ?? "");
    expect(Object.keys(refused.error?.extensions ?? {}).sort()).toEqual(
      Object.keys(perAddress?.error?.extensions ?? {}).sort(),
    );
    expect(refused.error?.extensions["code"]).toBe("MAIL_THROTTLED");
    expect(refused.response.headers.has("retry-after")).toBe(
      perAddress?.response.headers.has("retry-after") ?? false,
    );
    await close();
  });
});

describe("Redis down", () => {
  test("the request goes through, logged", async () => {
    const redis = await openAppRedis(server.uri, () => {}, base);
    const logs: string[] = [];
    const throttle = createSignInThrottle(redis.limits, (m) => logs.push(m));
    await redis.close();
    await throttle.check({ tenantId: "t", ip: "203.0.113.9" });
    expect(logs.length).toBe(1);
  });
});
