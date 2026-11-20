import { describe, expect, test } from "bun:test";
import {
  ACR,
  acrOf,
  amrOut,
  assess,
  type Demands,
  FRESH_GRACE_SECONDS,
} from "./authentication-level";

const NOW = new Date("2026-11-19T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const none: Demands = {
  acrValues: [],
  maxAge: null,
  prompt: [],
  mode: "passkeySufficient",
};
const factors = { available: true };

describe("acrOf and amrOut", () => {
  test("a passkey is phishing resistant, a second factor is mfa, the rest is 1fa", () => {
    expect(acrOf(["hwk", "user"])).toBe(ACR.phishingResistant);
    expect(acrOf(["hwk", "user", "mfa"])).toBe(ACR.phishingResistant);
    expect(acrOf(["otp", "mfa"])).toBe(ACR.mfa);
    expect(acrOf(["otp"])).toBe(ACR.first);
    expect(acrOf(["fed"])).toBe(ACR.first);
    expect(acrOf([])).toBe(ACR.first);
  });

  test("a lone otp is the e-mailed code, an otp beside mfa the app's", () => {
    expect(amrOut(["otp"])).toEqual(["email"]);
    expect(amrOut(["otp", "mfa"])).toEqual(["otp", "mfa"]);
    expect(amrOut(["hwk", "user"])).toEqual(["hwk", "user"]);
    expect(amrOut(["fed", "mfa"])).toEqual(["fed", "mfa"]);
  });
});

describe("assess", () => {
  const code = { amr: ["otp"], authenticatedAt: ago(30) };
  const passkey = { amr: ["hwk", "user"], authenticatedAt: ago(30) };

  test("no demand is met by any session", () => {
    const out = assess(code, none, factors, NOW);
    expect(out).toMatchObject({
      met: true,
      missing: [],
      required: null,
      acr: ACR.first,
      amr: ["email"],
    });
  });

  test("acr_values mfa is missing a second factor for a code-only session", () => {
    const out = assess(code, { ...none, acrValues: [ACR.mfa] }, factors, NOW);
    expect(out).toMatchObject({
      met: false,
      missing: ["SECOND_FACTOR"],
      required: ACR.mfa,
      acr: ACR.first,
    });
  });

  test("with no factor to use, the gap is the enrolment", () => {
    const out = assess(
      code,
      { ...none, acrValues: [ACR.mfa] },
      { available: false },
      NOW,
    );
    expect(out.missing).toEqual(["ENROLMENT"]);
  });

  test("a passkey meets mfa and phr, and the approval names the requested value", () => {
    const mfa = assess(
      passkey,
      { ...none, acrValues: [ACR.mfa] },
      factors,
      NOW,
    );
    expect(mfa).toMatchObject({ met: true, acr: ACR.mfa });
    const phr = assess(
      passkey,
      { ...none, acrValues: [ACR.phishingResistant] },
      factors,
      NOW,
    );
    expect(phr).toMatchObject({ met: true, acr: ACR.phishingResistant });
  });

  test("phr without a passkey is an enrolment, from 1fa and from mfa alike", () => {
    const noPasskey = { available: true, passkey: false };
    const demands = { ...none, acrValues: [ACR.phishingResistant] };
    for (const amr of [["otp"], ["otp", "mfa"]]) {
      const out = assess(
        { amr, authenticatedAt: ago(30) },
        demands,
        noPasskey,
        NOW,
      );
      expect(out.missing).toEqual(["ENROLMENT"]);
    }
    const withPasskey = assess(
      { amr: ["otp", "mfa"], authenticatedAt: ago(30) },
      demands,
      { available: true, passkey: true },
      NOW,
    );
    expect(withPasskey.missing).toEqual(["SECOND_FACTOR"]);
  });

  test("an app code meets mfa but not phr", () => {
    const totp = { amr: ["otp", "mfa"], authenticatedAt: ago(30) };
    expect(
      assess(totp, { ...none, acrValues: [ACR.mfa] }, factors, NOW).met,
    ).toBe(true);
    expect(
      assess(
        totp,
        { ...none, acrValues: [ACR.phishingResistant] },
        factors,
        NOW,
      ).met,
    ).toBe(false);
  });

  test("any one of several values satisfies the request", () => {
    const out = assess(
      code,
      { ...none, acrValues: [ACR.mfa, ACR.first] },
      factors,
      NOW,
    );
    expect(out).toMatchObject({ met: true, acr: ACR.first });
  });

  test("a request naming only values Clavix does not issue cannot be met", () => {
    const out = assess(
      passkey,
      { ...none, acrValues: ["urn:other:acr"] },
      factors,
      NOW,
    );
    expect(out).toMatchObject({ met: false, missing: [] });
  });

  test("required mode asks a multi-factor session whatever the request says", () => {
    const required = { ...none, mode: "required" as const };
    expect(assess(code, required, factors, NOW)).toMatchObject({
      met: false,
      missing: ["SECOND_FACTOR"],
      required: ACR.mfa,
    });
    expect(assess(code, required, { available: false }, NOW).missing).toEqual([
      "ENROLMENT",
    ]);
    expect(assess(passkey, required, factors, NOW).met).toBe(true);
  });

  test("max_age counts the age of the last proof", () => {
    const old = { amr: ["otp"], authenticatedAt: ago(600) };
    expect(assess(old, { ...none, maxAge: 900 }, factors, NOW).met).toBe(true);
    expect(assess(old, { ...none, maxAge: 300 }, factors, NOW)).toMatchObject({
      met: false,
      missing: ["FRESH_PROOF"],
      maxAge: 300,
    });
  });

  test("prompt=login and max_age=0 need a proof of the last minute", () => {
    const stale = {
      amr: ["otp"],
      authenticatedAt: ago(FRESH_GRACE_SECONDS + 5),
    };
    const prompt = assess(stale, { ...none, prompt: ["login"] }, factors, NOW);
    expect(prompt).toMatchObject({
      met: false,
      missing: ["FRESH_PROOF"],
      maxAge: 0,
    });
    expect(assess(stale, { ...none, maxAge: 0 }, factors, NOW).met).toBe(false);
    expect(assess(code, { ...none, maxAge: 0 }, factors, NOW).met).toBe(true);
  });

  test("a stale code session that also lacks the factor is missing both", () => {
    const stale = { amr: ["otp"], authenticatedAt: ago(900) };
    const out = assess(
      stale,
      { ...none, acrValues: [ACR.mfa], maxAge: 60 },
      factors,
      NOW,
    );
    expect(out.missing).toEqual(["SECOND_FACTOR", "FRESH_PROOF"]);
  });
});
