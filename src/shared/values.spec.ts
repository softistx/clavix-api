import { expect, test } from "bun:test";
import {
  isNonEmpty,
  isOneOf,
  isRecord,
  propertyOf,
  stringListOf,
  stringsOf,
  unique,
} from "./values";

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

test("isOneOf narrows a value to the listed strings", () => {
  const list = ["a", "b"] as const;
  expect(isOneOf(list, "a")).toBe(true);
  expect(isOneOf(list, "c")).toBe(false);
  expect(isOneOf(list, 1)).toBe(false);
  expect(isOneOf(list, undefined)).toBe(false);
});

test("isNonEmpty tells a list with an item from an empty one", () => {
  expect(isNonEmpty([])).toBe(false);
  expect(isNonEmpty([1])).toBe(true);
  expect(isNonEmpty([undefined])).toBe(true);
});

test("propertyOf reads a property of an object, undefined of anything else", () => {
  expect(propertyOf({ a: 1 }, "a")).toBe(1);
  expect(propertyOf({ a: 1 }, "b")).toBeUndefined();
  expect(propertyOf(new Error("x"), "message")).toBe("x");
  expect(propertyOf(null, "a")).toBeUndefined();
  expect(propertyOf("text", "length")).toBeUndefined();
  expect(propertyOf(undefined, "a")).toBeUndefined();
});

test("stringListOf keeps the strings of an array, nothing of anything else", () => {
  expect(stringListOf(["a", 1, "b", null])).toEqual(["a", "b"]);
  expect(stringListOf("a")).toEqual([]);
  expect(stringListOf(undefined)).toEqual([]);
  expect(stringListOf({ 0: "a" })).toEqual([]);
});

test("stringsOf keeps the entries that hold a string", () => {
  expect(stringsOf({ a: "x", b: 1, c: null, d: "", e: ["y"] })).toEqual({
    a: "x",
    d: "",
  });
  expect(stringsOf({})).toEqual({});
});
