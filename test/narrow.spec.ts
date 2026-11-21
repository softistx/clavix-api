import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defined, instance, parsed, recordOf } from "~/narrow";

describe("defined", () => {
  test("returns the value, falsy ones included", () => {
    expect(defined("a")).toBe("a");
    expect(defined(0)).toBe(0);
    expect(defined("")).toBe("");
    expect(defined(false)).toBe(false);
  });

  test("throws on null and undefined, naming what was expected", () => {
    expect(() => defined(null, "the user")).toThrow(
      "expected the user to be defined",
    );
    expect(() => defined(undefined)).toThrow("expected value to be defined");
  });
});

describe("instance", () => {
  test("returns a value of the type", () => {
    const error = new RangeError("x");
    expect(instance(error, RangeError)).toBe(error);
    expect(instance(error, Error)).toBe(error);
  });

  test("throws on a value of another type, naming the type", () => {
    expect(() => instance(new Error("x"), RangeError)).toThrow(
      "expected an instance of RangeError",
    );
    expect(() => instance("text", Date)).toThrow(/Date/);
    expect(() => instance(null, Error)).toThrow();
  });
});

describe("parsed", () => {
  test("returns the value the schema describes", () => {
    expect(parsed(z.object({ n: z.number() }), { n: 1 })).toEqual({ n: 1 });
  });

  test("throws on a value it does not describe", () => {
    expect(() => parsed(z.string(), 1)).toThrow();
  });
});

describe("recordOf", () => {
  test("returns the fields of an object", () => {
    expect(recordOf({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
  });

  test("throws on null, an array or a primitive", () => {
    expect(() => recordOf(null, "the body")).toThrow(
      "expected the body to be an object",
    );
    expect(() => recordOf([1])).toThrow("expected value to be an object");
    expect(() => recordOf("x")).toThrow();
  });
});
