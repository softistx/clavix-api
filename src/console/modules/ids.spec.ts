import { describe, expect, test } from "bun:test";
import { pageSize } from "./ids";

describe("pageSize", () => {
  test("defaults to 25", () => {
    expect(pageSize(undefined)).toBe(25);
    expect(pageSize(null)).toBe(25);
  });

  test("stays within 1 and 100", () => {
    expect(pageSize(0)).toBe(1);
    expect(pageSize(-5)).toBe(1);
    expect(pageSize(40)).toBe(40);
    expect(pageSize(500)).toBe(100);
  });

  test("takes its own default and maximum", () => {
    expect(pageSize(undefined, 10, 20)).toBe(10);
    expect(pageSize(0, 10, 20)).toBe(1);
    expect(pageSize(500, 10, 20)).toBe(20);
  });
});
