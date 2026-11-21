import { describe, expect, test } from "bun:test";
import { isMonth, messageOf, meter, monthOf } from "./usage.utils";

describe("usage utils", () => {
  test("monthOf is the UTC month", () => {
    expect(monthOf(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(monthOf(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });

  test("isMonth accepts YYYY-MM only", () => {
    expect(isMonth("2026-01")).toBe(true);
    for (const bad of ["2026-13", "2026-00", "26-01", "2026-1", ""]) {
      expect(isMonth(bad)).toBe(false);
    }
  });

  test("a meter is exceeded past its quota, never without one", () => {
    expect(meter(5, 5)).toEqual({ used: 5, quota: 5, exceeded: false });
    expect(meter(6, 5).exceeded).toBe(true);
    expect(meter(10 ** 9, null).exceeded).toBe(false);
  });

  test("messageOf reads an Error's message or stringifies", () => {
    expect(messageOf(new Error("down"))).toBe("down");
    expect(messageOf("plain")).toBe("plain");
  });
});
