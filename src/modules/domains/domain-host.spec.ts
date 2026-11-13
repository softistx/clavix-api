import { describe, expect, test } from "bun:test";
import { DomainHostError, normalizeDomainHost, txtNameOf } from "./domain-host";

const norm = (raw: string) => normalizeDomainHost(raw, "clavix.test");

describe("normalizeDomainHost", () => {
  test("lowercases, drops the trailing dot, converts IDN to punycode", () => {
    expect(norm("Auth.Acme.COM")).toBe("auth.acme.com");
    expect(norm("auth.acme.com.")).toBe("auth.acme.com");
    expect(norm("  auth.acme.com ")).toBe("auth.acme.com");
    expect(norm("bücher.example.org")).toBe("xn--bcher-kva.example.org");
  });

  test.each([
    "",
    "*.acme.com",
    "localhost",
    "app.localhost",
    "acme",
    "127.0.0.1",
    "10.0.0.1",
    "0x7f.1",
    "[::1]",
    "https://acme.com",
    "acme.com:8080",
    "acme.com/path",
    "user@acme.com",
    "-bad.acme.com",
    "a..b.com",
    "clavix.test",
    "evil.clavix.test",
    "printer.local",
    "x.internal",
    "a b.com",
  ])("refuses %p", (raw) => {
    expect(() => norm(raw)).toThrow(DomainHostError);
  });

  test("the TXT record sits under _clavix", () => {
    expect(txtNameOf("auth.acme.com")).toBe("_clavix.auth.acme.com");
  });
});
