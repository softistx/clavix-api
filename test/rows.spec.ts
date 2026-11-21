import { describe, expect, test } from "bun:test";
import { manyRows, oneRow, recordsOf, rowsOf, textOf } from "~/rows";

describe("rows", () => {
  const answer = {
    data: { item: { id: "1", n: 5 }, items: [{ id: "1" }, { id: "2" }] },
  };

  test("oneRow reads the object at a field and keeps its other fields", () => {
    expect(oneRow(answer, "item")).toEqual({ id: "1", n: 5 });
  });

  test("manyRows reads the list at a field", () => {
    expect(manyRows(answer, "items").map((row) => row.id)).toEqual(["1", "2"]);
  });

  test("both fail the spec on an answer with errors", () => {
    const failed = { data: null, errors: [{ message: "no" }] };
    expect(() => oneRow(failed, "item")).toThrow();
    expect(() => manyRows(failed, "items")).toThrow();
  });

  test("both fail on a row without an id", () => {
    expect(() => oneRow({ data: { item: { n: 1 } } }, "item")).toThrow();
    expect(() => manyRows({ data: { items: [{}] } }, "items")).toThrow();
  });

  test("rowsOf, textOf and recordsOf narrow a nested value", () => {
    expect(rowsOf([{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(textOf("x")).toBe("x");
    expect(recordsOf([{ a: 1 }, {}])).toEqual([{ a: 1 }, {}]);
    expect(() => rowsOf([{}])).toThrow();
    expect(() => textOf(1)).toThrow();
    expect(() => recordsOf([1])).toThrow();
  });
});
