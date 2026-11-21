import { describe, expect, test } from "bun:test";
import { fingerprintOf, originOf, rpIdOf } from "./users.rp";

const tenant = { slugIssuer: "https://acme.clavix.test:8443" };

describe("the relying party of a tenant", () => {
  test("the rpId is its host without the port, the origin keeps it", () => {
    expect(rpIdOf(tenant)).toBe("acme.clavix.test");
    expect(originOf(tenant)).toBe("https://acme.clavix.test:8443");
  });
});

describe("fingerprintOf", () => {
  test("is 12 hex characters, whatever the order of the origins", () => {
    const a = fingerprintOf(["https://a.test", "https://b.test"]);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprintOf(["https://b.test", "https://a.test"])).toBe(a);
  });

  test("changes with the list", () => {
    expect(fingerprintOf([])).not.toBe(fingerprintOf(["https://a.test"]));
  });
});
