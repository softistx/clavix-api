import { describe, expect, test } from "bun:test";
import { platformHostPolicy, tlsAsk } from "./tls-ask";
import { relatedOrigins } from "./well-known";

const SECRET = "s".repeat(40);
const ask = (
  over: Partial<Parameters<typeof tlsAsk>[0]> = {},
  allowedHosts = ["auth.acme.com"],
) =>
  tlsAsk({
    secret: SECRET,
    platformDomain: "clavix.test",
    allowed: async (host) => allowedHosts.includes(host),
    log: () => {},
    ...over,
  });
const url = (q: string) => `http://127.0.0.1/internal/tls/ask?${q}`;
const get = (
  handler: ReturnType<typeof tlsAsk>,
  q: string,
  init?: RequestInit,
) => handler(new Request(url(q), init));

describe("tlsAsk", () => {
  test("200 for an allowed host, bare body", async () => {
    const res = await get(ask(), `token=${SECRET}&domain=Auth.Acme.com.`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("404 for an unknown, pending, lapsed or suspended host alike", async () => {
    const res = await get(ask(), `token=${SECRET}&domain=other.acme.com`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  test("404 for a wrong or missing token, or no secret configured", async () => {
    expect((await get(ask(), "token=nope&domain=auth.acme.com")).status).toBe(
      404,
    );
    expect((await get(ask(), "domain=auth.acme.com")).status).toBe(404);
    expect(
      (
        await get(
          ask({ secret: undefined }),
          `token=${SECRET}&domain=auth.acme.com`,
        )
      ).status,
    ).toBe(404);
  });

  test("404 for proxied requests and non-GET", async () => {
    const q = `token=${SECRET}&domain=auth.acme.com`;
    for (const header of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "forwarded",
    ]) {
      expect(
        (await get(ask(), q, { headers: { [header]: "1.2.3.4" } })).status,
      ).toBe(404);
    }
    expect((await get(ask(), q, { method: "POST" })).status).toBe(404);
  });

  test("platform hosts go to allowedPlatformHost, never to the custom store", async () => {
    let custom = 0;
    const known = ["acme.clavix.test", "console.clavix.test"];
    const handler = ask({
      allowed: async () => {
        custom++;
        return true;
      },
      allowedPlatformHost: async (host) => known.includes(host),
    });
    for (const [domain, status] of [
      ["Acme.clavix.test", 200],
      ["console.clavix.test.", 200],
      ["ghost.clavix.test", 404],
      ["a.b.clavix.test", 404],
      ["clavix.test.evil.com", 200],
    ] as const) {
      expect(
        (await get(handler, `token=${SECRET}&domain=${domain}`)).status,
      ).toBe(status);
    }
    expect(custom).toBe(1); // only clavix.test.evil.com is a custom host
  });

  test("404 for platform domains, IPs and garbage, without asking the store", async () => {
    let asked = 0;
    const handler = ask({
      allowed: async () => {
        asked++;
        return true;
      },
    });
    for (const domain of ["x.clavix.test", "1.2.3.4", "localhost", ""]) {
      expect(
        (await get(handler, `token=${SECRET}&domain=${domain}`)).status,
      ).toBe(404);
    }
    expect(asked).toBe(0);
  });

  test("429 past the limit, before any lookup", async () => {
    let asked = 0;
    const handler = ask({
      limit: async () => false,
      allowed: async () => {
        asked++;
        return true;
      },
    });
    expect(
      (await get(handler, `token=${SECRET}&domain=auth.acme.com`)).status,
    ).toBe(429);
    expect(asked).toBe(0);
  });

  test("malformed asks are refused without spending a limit slot", async () => {
    let spent = 0;
    const handler = ask({
      limit: async () => {
        spent++;
        return true;
      },
    });
    for (const domain of ["a.b.clavix.test", "1.2.3.4", "localhost", ""]) {
      expect(
        (await get(handler, `token=${SECRET}&domain=${domain}`)).status,
      ).toBe(404);
    }
    expect((await get(handler, "token=nope&domain=auth.acme.com")).status).toBe(
      404,
    );
    expect(spent).toBe(0);
    // a well-formed ask does spend one
    expect(
      (await get(handler, `token=${SECRET}&domain=auth.acme.com`)).status,
    ).toBe(200);
    expect(spent).toBe(1);
  });

  test("a failing lookup answers 404", async () => {
    const handler = ask({
      allowed: async () => {
        throw new Error("db down");
      },
    });
    expect(
      (await get(handler, `token=${SECRET}&domain=auth.acme.com`)).status,
    ).toBe(404);
  });
});

describe("platformHostPolicy", () => {
  const live = new Set(["acme.clavix.test"]);
  const policy = platformHostPolicy({
    domain: "Clavix.test",
    isLiveTenantHost: async (host) => live.has(host),
  });

  test("the apex and the console always, a slug host only when live", async () => {
    expect(await policy("clavix.test")).toBe(true);
    expect(await policy("console.clavix.test")).toBe(true);
    expect(await policy("acme.clavix.test")).toBe(true);
    // suspended, deleted or unknown: the tenant is not live
    expect(await policy("gone.clavix.test")).toBe(false);
    // not a slug shape: the tenant lookup is never reached
    expect(await policy("a.b.clavix.test")).toBe(false);
    expect(await policy("evilclavix.test")).toBe(false);
  });
});

describe("relatedOrigins", () => {
  test("lists the origins with the issuer's scheme and port", async () => {
    const res = relatedOrigins(["auth.acme.com"], { scheme: "https" });
    expect(await res.json()).toEqual({ origins: ["https://auth.acme.com"] });
    const dev = relatedOrigins(["a.test"], { scheme: "http", port: 3000 });
    expect(await dev.json()).toEqual({ origins: ["http://a.test:3000"] });
  });
});
