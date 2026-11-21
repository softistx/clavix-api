import { describe, expect, test } from "bun:test";
import { createApp } from "@/app";
import { createConsoleDeps } from "@/config/console";
import { CONSOLE_PATH } from "@/console/identity";
import { CLIENT_HEADER } from "./csrf";

const consoleDeps = {
  ...createConsoleDeps({ serverFor: async () => null }),
  authenticate: async () => null,
};
const json = { "content-type": "application/json" };
const QUERY = JSON.stringify({ query: "{ __typename }" });
const paths = [
  "http://acme.clavix.test/graphql",
  `http://localhost${CONSOLE_PATH}`,
];

interface Body {
  data?: unknown;
  errors?: { extensions?: { code?: string } }[];
}

const send = (
  required: boolean,
  url: string,
  headers: Record<string, string>,
) =>
  createApp({ requireClientHeader: required, console: consoleDeps }).request(
    url,
    { method: "POST", headers: { ...json, ...headers }, body: QUERY },
  );
const codeOf = async (response: Response) =>
  ((await response.json()) as Body).errors?.[0]?.extensions?.code;

describe.each(paths)("%s", (url) => {
  test("on: a request without the header is 403 before it is parsed", async () => {
    const response = await send(true, url, {});
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("CLIENT_HEADER_REQUIRED");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("on: a blank header counts as missing", async () => {
    const response = await send(true, url, { [CLIENT_HEADER]: "  " });
    expect(response.status).toBe(403);
  });

  test("on: a request with the header reaches the resolvers", async () => {
    const response = await send(true, url, { [CLIENT_HEADER]: "clavix-ui" });
    expect(await codeOf(response)).not.toBe("CLIENT_HEADER_REQUIRED");
  });

  test("off: a request without the header is accepted", async () => {
    const response = await send(false, url, {});
    expect(await codeOf(response)).not.toBe("CLIENT_HEADER_REQUIRED");
  });

  test("off: a request with the header is accepted too", async () => {
    const response = await send(false, url, { [CLIENT_HEADER]: "clavix-ui" });
    expect(await codeOf(response)).not.toBe("CLIENT_HEADER_REQUIRED");
  });
});

test("on: a refused request runs no resolver", async () => {
  const response = await send(true, paths[0] as string, {});
  const body = (await response.json()) as Body;
  expect(body.data).toBeUndefined();
});

test("on: a consent operation without the header is 403, never NOT_FOUND", async () => {
  // The client header runs before the same-origin guard, whose refusal of a
  // consent operation is NOT_FOUND (same-origin.spec.ts): a foreign Origin
  // would be 404 with the header present, and is 403 without it.
  const response = await createApp({ requireClientHeader: true }).request(
    paths[0] as string,
    {
      method: "POST",
      headers: { ...json, origin: "https://evil.clavix.test" },
      body: JSON.stringify({
        query: 'mutation { denyOAuthRequest(id: "x") { redirectTo } }',
      }),
    },
  );
  expect(response.status).toBe(403);
  expect(await codeOf(response)).toBe("CLIENT_HEADER_REQUIRED");
});

test("on: the IDE page (an HTML GET with no query) needs no header", async () => {
  const response = await createApp({
    requireClientHeader: true,
    ide: true,
  }).request(paths[0] as string, { headers: { accept: "text/html" } });
  expect(response.status).toBe(200);
});
