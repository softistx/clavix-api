import { describe, expect, test } from "bun:test";
import { extensionCodeOf } from "@/shared/errors";
import { cleanName, MAX_NAME, valueChangesOf } from "./account.utils";

const refusal = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("cleanName", () => {
  test("trims the name", () => {
    expect(cleanName("  Ada Lovelace ")).toBe("Ada Lovelace");
  });

  test("refuses a blank name and one past 200 characters", () => {
    expect(extensionCodeOf(refusal(() => cleanName("   ")))).toBe(
      "BAD_USER_INPUT",
    );
    expect(cleanName("a".repeat(MAX_NAME))).toHaveLength(MAX_NAME);
    expect(
      extensionCodeOf(refusal(() => cleanName("a".repeat(MAX_NAME + 1)))),
    ).toBe("BAD_USER_INPUT");
  });
});

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
