import { describe, expect, test } from "bun:test";
import { tlsAsk } from "./tls-ask";
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
    for (const header of ["x-forwarded-for", "x-forwarded-host", "forwarded"]) {
      expect(
        (await get(ask(), q, { headers: { [header]: "1.2.3.4" } })).status,
      ).toBe(404);
    }
    expect((await get(ask(), q, { method: "POST" })).status).toBe(404);
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

describe("relatedOrigins", () => {
  test("lists the origins with the issuer's scheme and port", async () => {
    const res = relatedOrigins(["auth.acme.com"], { scheme: "https" });
    expect(await res.json()).toEqual({ origins: ["https://auth.acme.com"] });
    const dev = relatedOrigins(["a.test"], { scheme: "http", port: 3000 });
    expect(await dev.json()).toEqual({ origins: ["http://a.test:3000"] });
  });
});
