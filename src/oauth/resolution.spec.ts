import { describe, expect, test } from "bun:test";
import { fingerprintOf } from "./resolution";

const URI = "https://a.test/api";
const scopes = ["read"];

describe("fingerprintOf", () => {
  test("a resource without the flag keeps one fingerprint: absent, undefined or false", () => {
    const absent = fingerprintOf({ [URI]: { scopes } });
    expect(fingerprintOf({ [URI]: { scopes, enforceRbac: undefined } })).toBe(
      absent,
    );
    // The model stores `true` or nothing; a stray false must not rebuild the issuer.
    expect(
      fingerprintOf({
        // @ts-expect-error a stored false from an old document: the model stores true or nothing
        [URI]: { scopes, enforceRbac: false },
      }),
    ).toBe(absent);
  });

  test("turning enforceRbac on changes the fingerprint, so the issuer is rebuilt", () => {
    expect(fingerprintOf({ [URI]: { scopes, enforceRbac: true } })).not.toBe(
      fingerprintOf({ [URI]: { scopes } }),
    );
  });
});
