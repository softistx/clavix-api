import { describe, expect, test } from "bun:test";
import { localeOfCtx, perRequest, requestOf } from "./consent.utils";

describe("perRequest", () => {
  test("reads once per request and keeps requests apart", async () => {
    let reads = 0;
    const read = perRequest<number>();
    const reader = async () => ++reads;
    const a = new Request("https://a.test/");
    const b = new Request("https://b.test/");
    expect(await read(a, reader)).toBe(1);
    expect(await read(a, reader)).toBe(1);
    expect(await read(b, reader)).toBe(2);
  });

  test("reads nothing without a request", () => {
    const read = perRequest<number>();
    expect(read(undefined, async () => 1)).toBeUndefined();
  });
});

describe("requestOf", () => {
  test("returns the context's request, or refuses as NOT_FOUND", () => {
    const request = new Request("https://a.test/");
    expect(requestOf({ request })).toBe(request);
    expect(() => requestOf({})).toThrow();
  });
});

describe("localeOfCtx", () => {
  test("reads accept-language and tolerates no request", () => {
    const ctx = (request?: Request) => ({ request }) as never;
    expect(localeOfCtx(ctx())).toBe(localeOfCtx(ctx(new Request("http://x"))));
    expect(
      localeOfCtx(
        ctx(new Request("http://x", { headers: { "accept-language": "fr" } })),
      ),
    ).toBe("fr");
  });
});
