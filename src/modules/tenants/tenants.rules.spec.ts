import { describe, expect, test } from "bun:test";
import { RESERVED_SLUGS, slugProblem } from "./tenants.rules";

describe("slugProblem", () => {
  test("accepts DNS labels", () => {
    for (const slug of ["ab", "acme", "acme-school", "a1", "x".repeat(63)]) {
      expect(slugProblem(slug)).toBeUndefined();
    }
  });

  test("refuses bad shapes", () => {
    for (const slug of [
      "",
      "a",
      "x".repeat(64),
      "Acme",
      "-acme",
      "acme-",
      "ac--me",
      "ac_me",
      "ac.me",
      "école",
    ]) {
      expect(slugProblem(slug)).toBeString();
    }
  });

  test("refuses every reserved label", () => {
    expect(RESERVED_SLUGS).toHaveLength(12);
    for (const slug of RESERVED_SLUGS) {
      expect(slugProblem(slug)).toContain("reserved");
    }
  });
});
