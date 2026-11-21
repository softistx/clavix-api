import { describe, expect, test } from "bun:test";
import { createApp } from "@/app";
import { clientHeaders } from "~/client-header";

const app = createApp();
const LEAK = "987654321";
const MEDIA = ["application/json", "application/graphql-response+json"];

const post = (accept: string, query: string, variables: unknown) =>
  app.request("http://acme.clavix.test/graphql", {
    method: "POST",
    headers: { ...clientHeaders, "content-type": "application/json", accept },
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

    test(`${accept}: an error's extensions.http names the status and never reaches the body`, async () => {
      const response = await post(accept, "{ currentUser { id } }", {});
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).not.toContain('"http"');
      expect(text).toContain("NOT_FOUND");
      const length = response.headers.get("content-length");
      if (length !== null)
        expect(Number(length)).toBe(new TextEncoder().encode(text).length);
    });
  }
});
