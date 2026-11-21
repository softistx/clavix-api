import { describe, expect, test } from "bun:test";
import { at } from "~/body";

describe("at", () => {
  const data = { me: { tenants: { items: [{ slug: "a" }], total: 1 } } };

  test("reads a nested value by dotted path, typed by the caller", () => {
    expect(at<number>(data, "me.tenants.total")).toBe(1);
    expect(at<{ slug: string }[]>(data, "me.tenants.items")).toEqual([
      { slug: "a" },
    ]);
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
