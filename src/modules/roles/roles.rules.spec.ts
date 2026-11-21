import { describe, expect, test } from "bun:test";
import type { RolesError } from "./roles.errors";
import {
  checkUserId,
  cleanDescription,
  cleanName,
  MAX_ID,
} from "./roles.rules";

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as RolesError;
  }
  return undefined;
};

describe("cleanName", () => {
  test("trims a valid name", () => {
    expect(cleanName("  admin:read.v1_x-y ")).toBe("admin:read.v1_x-y");
  });

  test("refuses blank, spaced, accented and over-long names", () => {
    for (const bad of ["", "   ", "a b", "é", "a".repeat(65)]) {
      expect(refusal(() => cleanName(bad))?.code).toBe("BAD_USER_INPUT");
    }
    expect(cleanName("a".repeat(64))).toHaveLength(64);
  });
});

describe("cleanDescription", () => {
  test("is empty when absent and trimmed otherwise", () => {
    expect(cleanDescription(undefined)).toBe("");
    expect(cleanDescription("  hi ")).toBe("hi");
  });

  test("holds at most 300 characters", () => {
    expect(cleanDescription("x".repeat(300))).toHaveLength(300);
    expect(refusal(() => cleanDescription("x".repeat(301)))?.code).toBe(
      "BAD_USER_INPUT",
    );
  });
});

describe("checkUserId", () => {
  test("accepts 1 to 200 characters and refuses the rest", () => {
    expect(() => checkUserId("u")).not.toThrow();
    expect(() => checkUserId("u".repeat(MAX_ID))).not.toThrow();
    expect(refusal(() => checkUserId(""))?.code).toBe("BAD_USER_INPUT");
    expect(refusal(() => checkUserId("u".repeat(MAX_ID + 1)))?.code).toBe(
      "BAD_USER_INPUT",
    );
  });
});
