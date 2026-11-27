import { describe, expect, test } from "bun:test";
import { valueChangesOf } from "./account.utils";

describe("valueChangesOf", () => {
  test("keeps a value and turns a missing or null one into a clear", () => {
    expect(
      valueChangesOf([
        { attributeId: "a", value: { text: "x" } },
        { attributeId: "b", value: null },
        { attributeId: "c" },
      ]),
    ).toEqual([
      { attributeId: "a", value: { text: "x" } },
      { attributeId: "b", value: null },
      { attributeId: "c", value: null },
    ]);
  });
});
