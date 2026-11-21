import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { at } from "~/body";

describe("at", () => {
  const data = { me: { tenants: { items: [{ slug: "a" }], total: 1 } } };

  test("reads a nested value by dotted path, checked by its schema", () => {
    expect(at(data, "me.tenants.total", z.number())).toBe(1);
    expect(
      at(
        data,
        "me.tenants.items",
        z.array(z.looseObject({ slug: z.string() })),
      ),
    ).toEqual([{ slug: "a" }]);
  });

  test("refuses a value its schema does not describe", () => {
    expect(() => at(data, "me.tenants.total", z.string())).toThrow();
    expect(() => at(data, "me.nobody", z.string())).toThrow();
  });

  test("gives undefined for a path that is not there", () => {
    expect(at(data, "me.nobody.total")).toBeUndefined();
    expect(at(data, "other")).toBeUndefined();
    expect(at(data, "me.tenants.total.deeper")).toBeUndefined();
  });

  test("gives undefined for a null or missing body", () => {
    expect(at(null, "me")).toBeUndefined();
    expect(at(undefined, "me")).toBeUndefined();
  });
});
