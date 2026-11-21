import { describe, expect, test } from "bun:test";
import type { ConsentCtx, WithServers } from "./consent.types";
import {
  appCtxOf,
  consentCtxOf,
  contextOf,
  isConsentCtx,
  isContext,
  isServerCtx,
  localeOfCtx,
  perRequest,
  requestOf,
} from "./consent.utils";

const notFound = expect.objectContaining({
  extensions: { code: "NOT_FOUND", http: { status: 404 } },
});

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

describe("isServerCtx", () => {
  test("accepts a context with a tenant reader, refuses anything else", () => {
    expect(isServerCtx({ tenant: async () => null })).toBe(true);
    expect(isServerCtx({ request: new Request("https://a.test/") })).toBe(
      false,
    );
    expect(isServerCtx({ tenant: "t" })).toBe(false);
    expect(isServerCtx(null)).toBe(false);
    expect(isServerCtx(undefined)).toBe(false);
  });
});

describe("appCtxOf", () => {
  test("returns the app's context, refuses another as NOT_FOUND", () => {
    const ctx = { tenant: async () => null };
    expect(appCtxOf(ctx)).toBe(ctx);
    expect(() => appCtxOf({})).toThrow(notFound);
  });
});

describe("contextOf", () => {
  const base = {
    tenant: async () => null,
    janus: { user: async () => null },
    deviceThrottle: { check: async () => {} },
  };
  test("accepts the app's context, refuses another as NOT_FOUND", () => {
    expect(isContext(base)).toBe(true);
    expect(Object.is(contextOf(base), base)).toBe(true);
    expect(isContext({ ...base, janus: undefined })).toBe(false);
    expect(isContext({ ...base, deviceThrottle: null })).toBe(false);
    expect(() => contextOf({ tenant: base.tenant })).toThrow(notFound);
  });
});

describe("consentCtxOf", () => {
  const readers = {
    oauthServers: { serverFor: async () => null },
    scopeTextsFor: async () => [],
    detailTextsFor: async () => [],
    agentsFor: async () => [],
  };
  test("accepts the consent readers' context, refuses another as NOT_FOUND", () => {
    expect(isConsentCtx(readers)).toBe(true);
    expect(Object.is(consentCtxOf(readers), readers)).toBe(true);
    expect(isConsentCtx({ ...readers, agentsFor: undefined })).toBe(false);
    expect(isConsentCtx(null)).toBe(false);
    expect(() => consentCtxOf({})).toThrow(notFound);
  });
});

describe("requestOf", () => {
  test("returns the context's request, or refuses as NOT_FOUND", () => {
    const request = new Request("https://a.test/");
    expect(requestOf({ request })).toBe(request);
    expect(() => requestOf({})).toThrow(notFound);
    expect(() => requestOf({ request: "https://a.test/" })).toThrow(notFound);
    expect(() => requestOf(null)).toThrow(notFound);
  });
});

describe("localeOfCtx", () => {
  test("reads accept-language and tolerates no request", () => {
    const base: WithServers = {
      oauthServers: { serverFor: async () => null },
      scopeTextsFor: async () => [],
      detailTextsFor: async () => [],
      agentsFor: async () => new Map(),
    };
    const ctx = (request?: Request): ConsentCtx =>
      request === undefined ? base : { ...base, request };
    expect(localeOfCtx(ctx())).toBe(localeOfCtx(ctx(new Request("http://x"))));
    expect(
      localeOfCtx(
        ctx(new Request("http://x", { headers: { "accept-language": "fr" } })),
      ),
    ).toBe("fr");
  });
});
