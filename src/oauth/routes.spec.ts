import { expect, test } from "bun:test";
import { BODY_LIMIT } from "@/app";
import { createTestApp } from "~/app";
import { OAUTH_PATHS } from "./routes";

// A stand-in for the issuers: answers what it was handed.
const seen: Request[] = [];
const app = createTestApp({
  oauth: {
    handle: async (request) => {
      seen.push(request);
      await request.clone().text(); // like janus: the form body is read
      return new Response(
        `${request.method} ${new URL(request.url).pathname}`,
        {
          status: 202,
        },
      );
    },
  },
});

test("every OAuth path reaches the issuers as a plain Request, any method", async () => {
  for (const path of OAUTH_PATHS) {
    const response = await app.request(`https://acme.clavix.test${path}`, {
      method: "POST",
      body: new URLSearchParams({ a: "b" }),
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe(`POST ${path}`);
  }
  expect(seen).toHaveLength(OAUTH_PATHS.length);
  expect(await seen[1]?.clone().text()).toBe("a=b");
});

test("the other routes are untouched", async () => {
  expect((await app.request("/healthz")).status).toBe(200);
  expect((await app.request("/nothing")).status).toBe(404);
});

test("without issuers no OAuth path exists", async () => {
  const bare = createTestApp();
  expect((await bare.request("/token", { method: "POST" })).status).toBe(404);
});

test("a body over the limit is refused when the issuers read it", async () => {
  const response = await app.request("https://acme.clavix.test/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `a=${"x".repeat(BODY_LIMIT + 1)}`,
  });
  expect(response.status).toBe(413);
});
