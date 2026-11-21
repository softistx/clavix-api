import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { defineRedis, openRedis } from "@softistx/redis";
import { startTestRedis, type TestRedis } from "@softistx/redis/testing";
import { RedisClient } from "bun";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { tenantResolver } from "@/config/tenancy";
import { createSignInThrottle, settled, signInLimits } from "@/modules/auth";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import {
  createHomeRealmThrottle,
  createSsoStartThrottle,
  type SsoLimitConfig,
  ssoLimits,
} from "./sign-in-methods.sso-throttle";

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
  await service.create({ slug: "sso-lima", name: "Lima", signUp: true });
  await service.create({ slug: "sso-mike", name: "Mike", signUp: true });
}, 300_000);
afterAll(async () => {
  await settled();
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await server?.stop();
});
beforeEach(() => server.reset());

const HOME = `query ($email: String!) { hostedHomeRealm(email: $email) { connectionId } }`;
const START = `mutation { socialSignInStart(provider: "nobody") { url } }`;
const CODE = `mutation ($email: EmailAddress!) {
  requestSignInCode(email: $email) { challenge }
}`;

const roomy = 1_000;
const base: SsoLimitConfig = {
  ipLimit: roomy,
  ipWindowSeconds: 600,
  tenantLimit: roomy,
  tenantWindowSeconds: 3600,
};

// An app over a Redis whose sign-in code budget is `code` and whose home-realm
// and SSO start budgets are `sso`; `ask` posts one operation to a tenant from
// a client address (the one proxy in front writes it).
async function setup(code: SsoLimitConfig, sso: SsoLimitConfig) {
  const client = new RedisClient(server.uri);
  const redis = await openRedis(
    defineRedis({
      client,
      prefix: "clavix",
      limits: { ...signInLimits(code), ...ssoLimits(sso) },
    }),
  );
  const fail = (message: string) => {
    throw new Error(message); // a spec never runs with Redis down
  };
  const app = createApp({
    signInThrottle: createSignInThrottle(redis.limits, fail),
    homeRealmThrottle: createHomeRealmThrottle(redis.limits, fail),
    ssoStartThrottle: createSsoStartThrottle(redis.limits, fail),
  });
  const ask = async (
    slug: string,
    ip: string,
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
    const response = await app.request(`${issuerOf(slug, origin)}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json()) as {
      errors?: { message: string; extensions: Record<string, unknown> }[];
    };
    return { response, error: body.errors?.[0] };
  };
  return {
    ask,
    close: async () => {
      await redis.close();
      client.close();
    },
  };
}

describe("an anonymous flood of home-realm lookups (G2-10)", () => {
  test("does not spend the tenant's sign-in code budget: its users still get their code", async () => {
    // The mail budget of the tenant is 3; the attacker sends 12 lookups from two addresses.
    const { ask, close } = await setup({ ...base, tenantLimit: 3 }, base);
    for (let i = 0; i < 12; i += 1) {
      const { error } = await ask("sso-lima", `203.0.113.${i % 2}`, HOME, {
        email: `a${i}@victim.test`,
      });
      expect(error).toBeUndefined();
    }
    const { response, error } = await ask("sso-lima", "198.51.100.9", CODE, {
      email: "user@example.test",
    });
    expect(error).toBeUndefined();
    expect(response.status).toBe(200);
    await close();
  });

  test("past its own limit a lookup is MAIL_THROTTLED, 429, with Retry-After; another address and another tenant are not", async () => {
    const { ask, close } = await setup(base, { ...base, ipLimit: 2 });
    const home = (slug: string, ip: string) =>
      ask(slug, ip, HOME, { email: "a@victim.test" });
    await home("sso-lima", "203.0.113.1");
    await home("sso-lima", "203.0.113.1");
    const { response, error } = await home("sso-lima", "203.0.113.1");
    expect(response.status).toBe(429);
    expect(error?.extensions["code"]).toBe("MAIL_THROTTLED");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await home("sso-lima", "203.0.113.2")).error).toBeUndefined();
    expect((await home("sso-mike", "203.0.113.1")).error).toBeUndefined();
    await close();
  });

  test("the tenant-wide cap of the lookups closes neither the codes nor the SSO start", async () => {
    const { ask, close } = await setup(base, { ...base, tenantLimit: 2 });
    await ask("sso-lima", "203.0.113.1", HOME, { email: "a@victim.test" });
    await ask("sso-lima", "203.0.113.2", HOME, { email: "b@victim.test" });
    const refused = await ask("sso-lima", "203.0.113.3", HOME, {
      email: "c@victim.test",
    });
    expect(refused.response.status).toBe(429);
    expect(
      (
        await ask("sso-lima", "203.0.113.3", CODE, {
          email: "user@example.test",
        })
      ).error,
    ).toBeUndefined();
    // The start has its own buckets: an unknown provider is refused by the
    // policy (404), not by a spent budget.
    const start = await ask("sso-lima", "203.0.113.3", START);
    expect(start.error?.extensions["code"]).toBe("SIGN_IN_METHOD_DISABLED");
    await close();
  });
});
