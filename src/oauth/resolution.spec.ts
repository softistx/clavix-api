import { describe, expect, test } from "bun:test";
import { fingerprintOf } from "./resolution";

const base = { "https://a.test/api": { scopes: ["read"] } };

describe("fingerprintOf", () => {
  test("turning enforceRbac on changes the fingerprint, so the issuer is rebuilt", () => {
    const on = {
      "https://a.test/api": { scopes: ["read"], enforceRbac: true as const },
    };
    expect(fingerprintOf(on)).not.toBe(fingerprintOf(base));
  });

  test("a resource without the flag keeps its fingerprint", () => {
    expect(fingerprintOf(base)).toBe(
      fingerprintOf({ "https://a.test/api": { scopes: ["read"] } }),
    );
  });
});
