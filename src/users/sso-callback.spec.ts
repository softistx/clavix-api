import { describe, expect, test } from "bun:test";
import { callbackUrlOf } from "@/modules/sign-in-methods/social";
import { connectionIdOfCallbackUrl } from "./tenant-janus";

describe("the callback URL of a connection (nxgt-janus#975)", () => {
  test("each connection has its own URL, and its id reads back from the path", () => {
    const url = callbackUrlOf("https://acme.clavix.test", "acme-corp");
    expect(url).toBe(
      "https://acme.clavix.test/sign-in/social/acme-corp/callback",
    );
    expect(connectionIdOfCallbackUrl(`${url}?code=c&state=s`)).toBe(
      "acme-corp",
    );
  });

  test("the one builder encodes the id, and the id reads back", () => {
    const url = callbackUrlOf("https://acme.clavix.test", "a b/c");
    expect(url).toBe(
      "https://acme.clavix.test/sign-in/social/a%20b%2Fc/callback",
    );
    expect(connectionIdOfCallbackUrl(url)).toBe("a b/c");
  });

  test("any other path, or a value that is not a URL, names no connection", () => {
    for (const value of [
      "https://acme.clavix.test/sign-in/sso/callback",
      "https://acme.clavix.test/sign-in/social/a/b/callback",
      "https://acme.clavix.test/sign-in/social//callback",
      "not a url",
    ]) {
      expect(connectionIdOfCallbackUrl(value)).toBeNull();
    }
  });
});
