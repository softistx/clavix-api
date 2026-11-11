import { describe, expect, test } from "bun:test";
import { hostOfRequest, normalizeHost, slugOfHost } from "./host";

const domain = "clavix.test";

describe("normalizeHost", () => {
  test("lowercases and strips the port and the trailing dot", () => {
    expect(normalizeHost("Acme.Clavix.Test:3000")).toBe("acme.clavix.test");
    expect(normalizeHost("acme.clavix.test.")).toBe("acme.clavix.test");
  });

  test("an IDN host becomes punycode", () => {
    expect(normalizeHost("café.clavix.test")).toBe("xn--caf-dma.clavix.test");
  });

  test("IPs and junk are none", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.1:3000",
      "[::1]",
      "[::1]:80",
      "",
      " ",
      "a b",
      "a/b",
      "u@acme.clavix.test",
    ]) {
      expect(normalizeHost(host)).toBeNull();
    }
  });
});

describe("slugOfHost", () => {
  test("a single valid label under the domain is the slug", () => {
    expect(slugOfHost("acme.clavix.test", domain)).toBe("acme");
    expect(slugOfHost("a-b-2.clavix.test", domain)).toBe("a-b-2");
  });

  test("the apex, deeper hosts, other domains and lookalikes are none", () => {
    for (const host of [
      "clavix.test",
      "a.b.clavix.test",
      "acme.other.test",
      "acme.clavix.test.evil.com",
      "xacme-clavix.test",
      ".clavix.test",
    ]) {
      expect(slugOfHost(host, domain)).toBeNull();
    }
  });

  test("reserved, too short and punycode labels are none", () => {
    for (const label of ["www", "console", "api", "a", "xn--caf-dma"]) {
      expect(slugOfHost(`${label}.${domain}`, domain)).toBeNull();
    }
  });
});

describe("hostOfRequest", () => {
  test("reads the URL's host, never X-Forwarded-Host", () => {
    const request = new Request("http://Acme.clavix.test:3000/x", {
      headers: { "x-forwarded-host": "evil.clavix.test" },
    });
    expect(hostOfRequest(request)).toBe("acme.clavix.test");
  });
});
