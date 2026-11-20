import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { createKeyGenerations } from "@/keys/generations";
import { ensureSigningKey } from "@/keys/rotation";
import { createTenantKeys, type TenantKeys } from "@/keys/signing-keys";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { withPublicDocuments } from "./public-documents";

const store = (keys: TenantKeys, tenantId: string) =>
  keys.signingKeysFor(tenantId);

const JWKS = "https://acme.clavix.test/jwks.json";

function setup(ttlSeconds = 60) {
  let version = 1;
  let clock = 1_000;
  let reads = 0;
  const generations = createKeyGenerations();
  const resolver = {
    resolveRequest: async (request: Request) =>
      new URL(request.url).host === "acme.clavix.test"
        ? ({ tenantId: "t1", version } as unknown as ResolvedTenant)
        : null,
  };
  const oauth = withPublicDocuments(
    {
      handle: async (request: Request) => {
        reads += 1; // each call stands for the store reads of a miss
        const { pathname } = new URL(request.url);
        if (pathname === "/nothing") return new Response("no", { status: 404 });
        return Response.json(
          { n: reads, pathname },
          { headers: { "cache-control": "public, max-age=300" } },
        );
      },
    },
    { resolver, generations, ttlSeconds, now: () => clock },
  );
  return {
    oauth,
    generations,
    reads: () => reads,
    setVersion: (v: number) => {
      version = v;
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("public documents cache", () => {
  test("a hit reads no store", async () => {
    const t = setup();
    const first = await t.oauth.handle(new Request(JWKS));
    const second = await t.oauth.handle(new Request(JWKS));
    expect(t.reads()).toBe(1);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get("cache-control")).toBe("public, max-age=300");
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
  });

  test("every document is cached, each by its own path", async () => {
    const t = setup();
    for (const path of [
      "/jwks.json",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
    ]) {
      await t.oauth.handle(new Request(`https://acme.clavix.test${path}`));
      await t.oauth.handle(new Request(`https://acme.clavix.test${path}`));
    }
    expect(t.reads()).toBe(3);
  });

  test("a matching If-None-Match answers 304 with no body", async () => {
    const t = setup();
    const etag = (await t.oauth.handle(new Request(JWKS))).headers.get("etag");
    expect(etag).not.toBeNull();
    for (const condition of [etag ?? "", `W/${etag}`, `"x", ${etag}`, "*"]) {
      const response = await t.oauth.handle(
        new Request(JWKS, { headers: { "if-none-match": condition } }),
      );
      expect(response.status).toBe(304);
      expect(await response.text()).toBe("");
    }
    const other = await t.oauth.handle(
      new Request(JWKS, { headers: { "if-none-match": '"other"' } }),
    );
    expect(other.status).toBe(200);
    expect(t.reads()).toBe(1);
  });

  test("a key rotation misses the cache", async () => {
    const t = setup();
    await t.oauth.handle(new Request(JWKS));
    t.generations.bump("t1");
    const after = await t.oauth.handle(new Request(JWKS));
    expect((await after.json()).n).toBe(2);
  });

  test("a tenant change misses the cache", async () => {
    const t = setup();
    await t.oauth.handle(new Request(JWKS));
    t.setVersion(2);
    await t.oauth.handle(new Request(JWKS));
    expect(t.reads()).toBe(2);
  });

  test("the TTL is the backstop", async () => {
    const t = setup(60);
    await t.oauth.handle(new Request(JWKS));
    t.tick(59_000);
    await t.oauth.handle(new Request(JWKS));
    expect(t.reads()).toBe(1);
    t.tick(2_000);
    await t.oauth.handle(new Request(JWKS));
    expect(t.reads()).toBe(2);
  });

  test("an unknown host, a non-GET and another path go through uncached", async () => {
    const t = setup();
    await t.oauth.handle(new Request("https://nobody.clavix.test/jwks.json"));
    await t.oauth.handle(new Request("https://nobody.clavix.test/jwks.json"));
    await t.oauth.handle(new Request(JWKS, { method: "POST" }));
    await t.oauth.handle(new Request("https://acme.clavix.test/userinfo"));
    await t.oauth.handle(new Request("https://acme.clavix.test/userinfo"));
    expect(t.reads()).toBe(5);
  });
});

describe("key generations", () => {
  test("inserting a key bumps the tenant's generation, a refused write does not", async () => {
    const generations = createKeyGenerations();
    const keys = createTenantKeys({
      db: mongo.db,
      masterKey: new Uint8Array(32).fill(7),
      generations,
    });
    const tenantId = new ObjectId().toHexString();
    await store(keys, tenantId).retire("missing", new Date(), new Date());
    expect(generations.of(tenantId)).toBe(0);
    await ensureSigningKey(keys.signingKeysFor, tenantId);
    expect(generations.of(tenantId)).toBeGreaterThan(0);
    expect(generations.of(new ObjectId().toHexString())).toBe(0);
  });
});
