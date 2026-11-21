import { describe, expect, test } from "bun:test";
import {
  confirmed,
  FRESH_WITHIN,
  FRESH_WITHIN_MS,
  iso,
  nameOf,
  signedInUserOf,
} from "./mfa.utils";

describe("mfa utils", () => {
  test("the freshness window agrees with its janus duration", () => {
    expect(FRESH_WITHIN).toBe("10m");
    expect(FRESH_WITHIN_MS).toBe(600_000);
  });

  test("iso reads a janus timestamp", () => {
    expect(iso("2026-11-20T10:00:00.000Z").getTime()).toBe(
      Date.UTC(2026, 10, 20, 10),
    );
  });

  test("nameOf keeps a non-blank string only", () => {
    expect(nameOf({ name: "Ada" })).toBe("Ada");
    expect(nameOf({ name: "" })).toBeNull();
    expect(nameOf({ name: 3 })).toBeNull();
    expect(nameOf({})).toBeNull();
  });

  test("confirmed ends the proof after the window", () => {
    const at = new Date("2026-11-20T10:00:00Z");
    expect(confirmed(at)).toEqual({
      confirmedAt: at,
      confirmedUntil: new Date("2026-11-20T10:10:00Z"),
    });
  });

  test("signedInUserOf nulls a missing name", () => {
    expect(
      signedInUserOf({ id: "u", email: "a@x.test", emailVerified: true }),
    ).toEqual({ id: "u", email: "a@x.test", name: null, emailVerified: true });
  });
});
