import { describe, expect, test } from "bun:test";
import { createApp } from "@/app";
import { useErrorStatus } from "./status";

const app = createApp();
const LEAK = "987654321";
const MEDIA = ["application/json", "application/graphql-response+json"];

const post = (accept: string, query: string, variables: unknown) =>
  app.request("http://acme.clavix.test/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify({ query, variables }),
  });

describe("the JSON plugins on each media type", () => {
  for (const accept of MEDIA) {
    test(`${accept}: a coercion error never quotes the value`, async () => {
      const response = await post(
        accept,
        'mutation V($c: String!) { verifySignInCode(challenge: "x", code: $c) { __typename } }',
        { c: { value: LEAK } },
      );
      expect(await response.text()).not.toContain(LEAK);
    });

    test(`${accept}: 429 and Retry-After are restored, extensions.http is dropped`, async () => {
      const body = {
        errors: [
          {
            message: "slow down",
            extensions: {
              code: "RATE_LIMITED",
              http: { status: 429, headers: { "retry-after": "7" } },
            },
          },
        ],
      };
      let out: Response | undefined;
      const hook = useErrorStatus().onResponse as unknown as (a: {
        response: Response;
        setResponse: (r: Response) => void;
      }) => Promise<void>;
      await hook({
        response: new Response(JSON.stringify(body), {
          headers: { "content-type": `${accept}; charset=utf-8` },
        }),
        setResponse: (r) => {
          out = r;
        },
      });
      expect(out?.status).toBe(429);
      expect(out?.headers.get("retry-after")).toBe("7");
      const text = (await out?.text()) ?? "";
      expect(text).not.toContain('"http"');
      expect(text).toContain("RATE_LIMITED");
    });
  }
});

describe("useErrorStatus without a named status", () => {
  test("extensions.http is still stripped and content-length dropped", async () => {
    let out: Response | undefined;
    const hook = useErrorStatus().onResponse as unknown as (a: {
      response: Response;
      setResponse: (r: Response) => void;
    }) => Promise<void>;
    const body = JSON.stringify({
      errors: [
        { message: "x", extensions: { code: "X", http: { headers: {} } } },
      ],
    });
    await hook({
      response: new Response(body, {
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
      }),
      setResponse: (r) => {
        out = r;
      },
    });
    expect(out?.status).toBe(200);
    expect(out?.headers.get("content-length")).toBeNull();
    expect(await out?.text()).not.toContain('"http"');
  });
});
