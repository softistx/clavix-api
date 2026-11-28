import { expect, test } from "bun:test";
import { hostedClaims } from "./claims";

// A context the app's `isContext` accepts, whose session read answers `user`.
const contextOf = (user: () => Promise<{ id: string } | null>) => ({
  tenant: () => Promise.resolve(null),
  janus: { user },
  deviceThrottle: {},
});

test("an anonymous caller is not authenticated", async () => {
  const claims = await hostedClaims(contextOf(async () => null));
  expect(claims.authenticated).toBe(false);
});

test("a signed-in caller is authenticated, as its user", async () => {
  const claims = await hostedClaims(contextOf(async () => ({ id: "u1" })));
  expect(claims).toEqual({
    authenticated: true,
    subject: { type: "user", id: "u1" },
  });
});

test("a failed session read is never taken for an anonymous caller", async () => {
  const outage = new Error("janus store down");
  const claims = await hostedClaims(
    contextOf(async () => {
      throw outage;
    }),
  );
  expect(() => claims.authenticated).toThrow(outage);
});
