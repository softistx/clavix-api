import { describe, expect, test } from "bun:test";
import { QuotaExceededError } from "./usage.errors";
import { assertWithinQuota } from "./usage.rules";

describe("assertWithinQuota", () => {
  test("passes under the quota and without one", () => {
    expect(() => assertWithinQuota("clients", 2, 3)).not.toThrow();
    expect(() => assertWithinQuota("domains", 1_000_000, null)).not.toThrow();
  });

  test("refuses a creation that would pass the quota", () => {
    expect(() => assertWithinQuota("clients", 3, 3)).toThrow(
      QuotaExceededError,
    );
    expect(() => assertWithinQuota("agents", 0, 0)).toThrow(QuotaExceededError);
  });
});
