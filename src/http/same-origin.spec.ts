import { describe, expect, test } from "bun:test";
import { createTestApp } from "~/app";
import { gqlOf } from "~/gql";

// The client header has its own spec (csrf.spec.ts); this one tests the
// same-origin guard alone, whatever CLAVIX_REQUIRE_CLIENT_HEADER says.
const app = createTestApp({ requireClientHeader: false });
const URL_ = "http://acme.clavix.test/graphql";
const json = { "content-type": "application/json" };
// graxia's own CSRF check runs first and stays on: a GET or a non-JSON POST
// carries this header to reach the same-origin guard.
const csrf = { "x-graphql-csrf": "1" };
const formHeaders = {
  ...csrf,
  "content-type": "application/x-www-form-urlencoded",
};

const post = (headers: Record<string, string>, body: unknown) =>
  app.request(URL_, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const codeOf = async (response: Response) =>
  (await gqlOf(response)).errors?.[0]?.extensions?.code;

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
      formHeaders,
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
      formHeaders,
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
      headers: { ...csrf, origin: "https://evil.clavix.test" },
    });
    expect(get.status).toBe(403);
    expect(await codeOf(get)).toBe("FORBIDDEN");
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

  test("graxia's CSRF header check still refuses a form post without its header", async () => {
    const response = await post(
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams(REQUEST_CODE).toString(),
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("CSRF_HEADER_REQUIRED");
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

describe("the Origin is compared by host", () => {
  test("https Origin against the http URL behind the proxy passes", async () => {
    const response = await post(
      { ...json, origin: "https://acme.clavix.test" },
      SIGN_OUT,
    );
    // Past the guard: whatever the operation answers, it is not the guard's FORBIDDEN.
    expect(response.status).not.toBe(403);
    expect(await codeOf(response)).not.toBe("FORBIDDEN");
  });

  test("a malformed Origin is refused", async () => {
    const response = await post({ ...json, origin: "not a url" }, SIGN_OUT);
    expect(response.status).toBe(403);
  });
});
