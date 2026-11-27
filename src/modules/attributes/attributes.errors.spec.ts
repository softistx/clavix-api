import { describe, expect, test } from "bun:test";
import { extensionCodeOf } from "@/shared/errors";
import { propertyOf } from "@/shared/values";
import { codes } from "./attributes.errors";
import { refuse, refuseCommon } from "./attributes.refusals";

const thrown = (run: () => never): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("attributes errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("attributes");
    expect([...codes.codes]).toEqual([
      "ATTRIBUTE_KEY_INVALID",
      "ATTRIBUTE_KEY_RESERVED",
      "ATTRIBUTE_KEY_TAKEN",
      "ATTRIBUTE_LIMIT",
      "ATTRIBUTE_TYPE_LOCKED",
      "ATTRIBUTE_UNIQUE_UNSUPPORTED",
      "ATTRIBUTE_NOT_UNIQUE",
      "ATTRIBUTE_EDITABLE_EMITTED",
      "ATTRIBUTE_SCOPE_UNKNOWN",
      "ATTRIBUTE_OPTION_IN_USE",
      "ATTRIBUTE_ARCHIVED",
      "ATTRIBUTE_NOT_ARCHIVED",
      "ATTRIBUTE_DELETE_UNCONFIRMED",
      "ATTRIBUTE_FAMILY_MISMATCH",
      "ATTRIBUTE_ROLE_NOT_HELD",
      "ATTRIBUTE_VALUE_INVALID",
      "ATTRIBUTE_VALUE_TAKEN",
      "ATTRIBUTE_REQUIRED",
      "ATTRIBUTE_NOT_EDITABLE",
    ]);
  });

  test("refuse carries the code, its status and the field", () => {
    const error = thrown(() => refuse("ATTRIBUTE_KEY_TAKEN", "taken", "key"));
    expect(extensionCodeOf(error)).toBe("ATTRIBUTE_KEY_TAKEN");
    const extensions = propertyOf(error, "extensions");
    expect(propertyOf(propertyOf(extensions, "http"), "status")).toBe(409);
    expect(propertyOf(extensions, "field")).toBe("key");
    const invalid = thrown(() => refuse("ATTRIBUTE_KEY_INVALID", "bad"));
    expect(extensionCodeOf(invalid)).toBe("ATTRIBUTE_KEY_INVALID");
  });

  test("refuseCommon uses the common codes", () => {
    expect(
      extensionCodeOf(thrown(() => refuseCommon("NOT_FOUND", "none"))),
    ).toBe("NOT_FOUND");
    expect(
      extensionCodeOf(thrown(() => refuseCommon("CONFLICT", "stale"))),
    ).toBe("CONFLICT");
    expect(
      extensionCodeOf(thrown(() => refuseCommon("BAD_USER_INPUT", "no", "f"))),
    ).toBe("BAD_USER_INPUT");
  });
});
