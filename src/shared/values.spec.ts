import { expect, test } from "bun:test";
import { isRecord, unique } from "./values";

test("unique keeps the first of each value, in order", () => {
  expect(unique(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  expect(unique([])).toEqual([]);
});

test("isRecord accepts plain objects only", () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord({ a: 1 })).toBe(true);
  expect(isRecord(null)).toBe(false);
  expect(isRecord([])).toBe(false);
  expect(isRecord("x")).toBe(false);
  expect(isRecord(undefined)).toBe(false);
});
