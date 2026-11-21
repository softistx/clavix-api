import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { startTestRedis, type TestRedis } from "@softistx/redis/testing";
import { RedisClient } from "bun";
import { openAppRedis } from "@/config/redis";
import { oauthPolicySchema } from "@/modules/oauth-policy";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import { redisTenantCache } from "./tenant-cache";

let server: TestRedis;
let raw: RedisClient;
let app: Awaited<ReturnType<typeof openAppRedis>>;
const warnings: string[] = [];

beforeAll(async () => {
  server = await startTestRedis();
  app = await openAppRedis(server.uri, (m) => warnings.push(m));
  raw = new RedisClient(server.uri);
}, 300_000); // the first run compiles Redis (~2 min), then it is cached
afterAll(async () => {
  raw?.close();
  await app?.close();
  await server?.stop();
});
beforeEach(() => server.reset());

const tenant = {
  tenantId: "65f0000000000000000000aa",
  slug: "acme",
  name: "Acme",
  signUp: false,
  status: "active" as const,
  issuer: "https://acme.clavix.test",
  slugIssuer: "https://acme.clavix.test",
  relatedOrigins: [],
  plan: "free" as const,
  partition: "65f0000000000000000000aa",
  version: 1,
  signIn: signInPolicySchema.parse(undefined),
  oauth: oauthPolicySchema.parse(undefined),
};
const ttl = (host: string) => raw.ttl(`clavix:tenant-host:${host}`);

test("a tenant is stored for the given TTL and read back", async () => {
  const cache = redisTenantCache(app.cache.tenantHost);
  expect(await cache.get("acme.clavix.test")).toBeUndefined();
  await cache.set("acme.clavix.test", tenant, 600);
  expect(await cache.get("acme.clavix.test")).toEqual(tenant);
  expect(await ttl("acme.clavix.test")).toBeGreaterThan(590);
  expect(await ttl("acme.clavix.test")).toBeLessThanOrEqual(600);
});

test("a null entry is kept for its own short TTL, apart from a miss", async () => {
  const cache = redisTenantCache(app.cache.tenantHost);
  await cache.set("ghost.clavix.test", null, 30);
  expect(await cache.get("ghost.clavix.test")).toBeNull();
  expect(await ttl("ghost.clavix.test")).toBeLessThanOrEqual(30);
  expect(await ttl("ghost.clavix.test")).toBeGreaterThan(20);
});

test("a value of a stale shape reads as a miss", async () => {
  const cache = redisTenantCache(app.cache.tenantHost);
  await raw.set(
    "clavix:tenant-host:old.clavix.test",
    JSON.stringify({ slug: "old" }),
  );
  expect(await cache.get("old.clavix.test")).toBeUndefined();
});

test("delete forgets a host", async () => {
  const cache = redisTenantCache(app.cache.tenantHost);
  await cache.set("acme.clavix.test", tenant, 600);
  await cache.delete("acme.clavix.test");
  expect(await cache.get("acme.clavix.test")).toBeUndefined();
});
