import { describe, expect, test } from "bun:test";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";

const app = createTestApp();
const LEAK = "987654321";

interface Body {
  errors?: { message: string; extensions?: { code?: string } }[];
}

const post = (query: string, variables: unknown) =>
  app.request("http://acme.clavix.test/graphql", {
    method: "POST",
    headers: { ...clientHeaders, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

// The console API's own case is in sign-in-methods.spec.ts (a clientSecret of
// the wrong type), which runs the whole app with the console mounted.
describe("variable coercion errors on the hosted /graphql", () => {
  for (const [name, code] of [
    ["an object", { value: LEAK }],
    ["a list", [LEAK]],
    ["a number", 987654321],
  ] as const) {
    test(`a code sent as ${name} is refused without quoting it back`, async () => {
      const response = await post(
        'mutation V($c: String!) { verifySignInCode(challenge: "x", code: $c) { __typename } }',
        { c: code },
      );
      const text = await response.text();
      expect(text).not.toContain(LEAK);
      const [error] = (JSON.parse(text) as Body).errors ?? [];
      expect(error?.message).toContain('Variable "$c" got an invalid value');
      expect(error?.extensions?.code).toBe("BAD_USER_INPUT");
    });
  }
});
