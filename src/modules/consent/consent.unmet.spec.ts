import { describe, expect, test } from "bun:test";
import { unmetAuthentication } from "./consent.errors";
import { denyUnreachable, isUnreachable } from "./consent.unmet";

describe("isUnreachable", () => {
  test("is true only for an unmet authentication with nothing the user could close", () => {
    expect(isUnreachable(unmetAuthentication([]))).toBe(true);
    expect(isUnreachable(unmetAuthentication(["mfa"]))).toBe(false);
    expect(isUnreachable(new Error("x"))).toBe(false);
  });
});

describe("denyUnreachable", () => {
  test("denies the request with the unmet error and answers its redirect", async () => {
    const seen: unknown[] = [];
    const answer = await denyUnreachable(
      {
        deny: async (id, options) => {
          seen.push([id, options.error]);
          return { redirectTo: "https://app.test/cb?error=x" };
        },
      },
      "r1",
    );
    expect(seen).toEqual([["r1", "unmet_authentication_requirements"]]);
    expect(answer).toEqual({ redirectTo: "https://app.test/cb?error=x" });
  });
});
