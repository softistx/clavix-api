import { describe, expect, test } from "bun:test";
import {
  cooldownSeconds,
  DomainHostError,
  hostsToForget,
  normalizeDomainHost,
  RECHECK_GRACE_DAYS,
  recheckOutcome,
  resolvingHosts,
  txtNameOf,
  VERIFY_COOLDOWN_SECONDS,
} from "./domains.rules";

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

describe("cooldownSeconds", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1_000);

  test("is zero for a claim never checked or checked long ago", () => {
    expect(cooldownSeconds(null, now)).toBe(0);
    expect(cooldownSeconds(ago(VERIFY_COOLDOWN_SECONDS), now)).toBe(0);
    expect(cooldownSeconds(ago(VERIFY_COOLDOWN_SECONDS + 5), now)).toBe(0);
  });

  test("is the whole seconds left, rounded up", () => {
    expect(cooldownSeconds(ago(0), now)).toBe(VERIFY_COOLDOWN_SECONDS);
    expect(cooldownSeconds(ago(59), now)).toBe(1);
    expect(cooldownSeconds(new Date(now.getTime() - 59_500), now)).toBe(1);
  });
});

describe("hostsToForget", () => {
  test("adds the slug host once, without duplicates", () => {
    expect(hostsToForget(["a.com", "a.com"], "t.clavix.test")).toEqual([
      "a.com",
      "t.clavix.test",
    ]);
    expect(hostsToForget(["a.com"], undefined)).toEqual(["a.com"]);
  });
});

describe("resolvingHosts", () => {
  test("adds a primary host that is not verified (a lapsed one)", () => {
    expect(resolvingHosts(["a.com"], "b.com")).toEqual(["a.com", "b.com"]);
    expect(resolvingHosts(["a.com"], "a.com")).toEqual(["a.com"]);
    expect(resolvingHosts(["a.com"], undefined)).toEqual(["a.com"]);
  });
});

describe("recheckOutcome", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 24 * 3_600_000);

  test("a lookup that failed changes nothing", () => {
    expect(
      recheckOutcome("LOOKUP_FAILED", { failingSince: null }, now),
    ).toEqual({ kind: "skip" });
  });

  test("a record that is there clears a failure streak", () => {
    expect(recheckOutcome(null, { failingSince: null }, now)).toEqual({
      kind: "fresh",
      clearFailing: false,
    });
    expect(recheckOutcome(null, { failingSince: days(2) }, now)).toEqual({
      kind: "fresh",
      clearFailing: true,
    });
  });

  test("a first failure starts the streak, and keeps it within the grace", () => {
    expect(recheckOutcome("NO_RECORD", { failingSince: null }, now)).toEqual({
      kind: "failing",
      since: now,
    });
    const since = days(RECHECK_GRACE_DAYS - 1);
    expect(recheckOutcome("MISMATCH", { failingSince: since }, now)).toEqual({
      kind: "failing",
      since,
    });
  });

  test("a streak of the whole grace lapses", () => {
    const since = days(RECHECK_GRACE_DAYS);
    expect(recheckOutcome("NO_RECORD", { failingSince: since }, now)).toEqual({
      kind: "lapse",
      since,
    });
  });
});
