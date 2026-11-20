import { describe, expect, test } from "bun:test";
import { createApp } from "@/app";

const app = createApp();
const URL_ = "http://acme.clavix.test/graphql";
const json = { "content-type": "application/json" };

const post = (headers: Record<string, string>, body: unknown) =>
  app.request(URL_, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

interface Body {
  data?: unknown;
  errors?: { extensions?: { code?: string } }[];
}
const codeOf = async (response: Response) =>
  ((await response.json()) as Body).errors?.[0]?.extensions?.code;

const SIGN_OUT = { query: "mutation { signOut }" };
const REQUEST_CODE = {
  query:
    'mutation { requestSignInCode(email: "ada@example.com") { challenge } }',
};
const VERIFY_CODE = {
  query:
    'mutation { verifySignInCode(challenge: "x", code: "000000") { __typename } }',
};
const CONSENT = {
  query: 'mutation { denyOAuthRequest(id: "x") { redirectTo } }',
};

describe("the same-origin guard on /graphql", () => {
  for (const [name, body] of [
    ["signOut", SIGN_OUT],
    ["requestSignInCode", REQUEST_CODE],
    ["verifySignInCode", VERIFY_CODE],
    ["currentUser", { query: "{ currentUser { id } }" }],
  ] as const) {
    test(`a foreign Origin cannot force ${name}: 403 FORBIDDEN, no CORS header`, async () => {
      const response = await post(
        { ...json, origin: "https://evil.clavix.test" },
        body,
      );
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("FORBIDDEN");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  }

  test("Origin: null is refused", async () => {
    const response = await post({ ...json, origin: "null" }, SIGN_OUT);
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("FORBIDDEN");
  });

  test("a form post is refused, also for the sign-in code", async () => {
    const response = await post(
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams(REQUEST_CODE).toString(),
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("FORBIDDEN");
  });

  test("a consent operation is refused as NOT_FOUND (404), JSON or form", async () => {
    const foreign = await post(
      { ...json, origin: "https://evil.clavix.test" },
      CONSENT,
    );
    expect(foreign.status).toBe(404);
    expect(await codeOf(foreign)).toBe("NOT_FOUND");
    const form = await post(
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams(CONSENT).toString(),
    );
    expect(await codeOf(form)).toBe("NOT_FOUND");
  });

  test("a mix of a consent and another operation is FORBIDDEN", async () => {
    const response = await post(
      { ...json, origin: "https://evil.clavix.test" },
      {
        query: 'mutation { signOut denyOAuthRequest(id: "x") { redirectTo } }',
      },
    );
    expect(await codeOf(response)).toBe("FORBIDDEN");
  });

  test("a foreign-Origin GET and a JSON array body are refused", async () => {
    const get = await app.request(`${URL_}?query=%7BcurrentUser%7Bid%7D%7D`, {
      headers: { origin: "https://evil.clavix.test" },
    });
    expect(get.status).toBe(403);
    const batch = await post({ ...json, origin: "https://evil.clavix.test" }, [
      SIGN_OUT,
    ]);
    expect(batch.status).toBe(403);
    expect(await codeOf(batch)).toBe("FORBIDDEN");
  });

  test("Origin: null on a consent operation is NOT_FOUND; an odd content-type fails closed", async () => {
    const nul = await post({ ...json, origin: "null" }, CONSENT);
    expect(await codeOf(nul)).toBe("NOT_FOUND");
    const odd = await post({ "content-type": "Application/JSON" }, SIGN_OUT);
    expect(odd.status).toBe(403);
  });

  test("the tenant's own Origin and a request with no Origin pass", async () => {
    for (const headers of [
      { ...json, origin: "http://acme.clavix.test" },
      json,
    ]) {
      const response = await post(headers, { query: "{ health { status } }" });
      expect(response.status).toBe(200);
    }
  });
});
