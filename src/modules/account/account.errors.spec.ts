import { describe, expect, test } from "bun:test";
import { extensionCodeOf } from "@/shared/errors";
import { propertyOf } from "@/shared/values";
import { codes, emailChangeInvalid } from "./account.errors";

describe("account errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("account");
    expect([...codes.codes]).toEqual(["EMAIL_CHANGE_INVALID"]);
  });

  test("emailChangeInvalid is EMAIL_CHANGE_INVALID, 400", () => {
    const error = emailChangeInvalid();
    expect(extensionCodeOf(error)).toBe("EMAIL_CHANGE_INVALID");
    expect(
      propertyOf(propertyOf(propertyOf(error, "extensions"), "http"), "status"),
    ).toBe(400);
  });
});
