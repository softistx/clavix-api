import { describe, expect, test } from "bun:test";
import { isCountryCode } from "./countries.utils";

describe("isCountryCode", () => {
  test("knows the assigned codes, in upper case only", () => {
    expect(isCountryCode("FR")).toBe(true);
    expect(isCountryCode("US")).toBe(true);
    expect(isCountryCode("fr")).toBe(false);
  });
  test("refuses an unassigned or malformed code", () => {
    expect(isCountryCode("ZZ")).toBe(false);
    expect(isCountryCode("FRA")).toBe(false);
    expect(isCountryCode("")).toBe(false);
  });
});
