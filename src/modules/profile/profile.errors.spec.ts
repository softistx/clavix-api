import { describe, expect, test } from "bun:test";
import { extensionCodeOf } from "@/shared/errors";
import { propertyOf } from "@/shared/values";
import { codes } from "./profile.errors";
import { refuse, refuseCommon } from "./profile.refusals";

const thrown = (run: () => never): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

const statusOf = (error: unknown) =>
  propertyOf(propertyOf(propertyOf(error, "extensions"), "http"), "status");

describe("profile errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("profile");
    expect([...codes.codes]).toEqual([
      "PROFILE_FIELD_INVALID",
      "PROFILE_FIELD_LOCKED",
    ]);
  });

  test("refuse carries the code, its status (400 invalid, 403 locked) and the field", () => {
    const invalid = thrown(() =>
      refuse("PROFILE_FIELD_INVALID", "bad", "phone"),
    );
    expect(extensionCodeOf(invalid)).toBe("PROFILE_FIELD_INVALID");
    expect(statusOf(invalid)).toBe(400);
    expect(propertyOf(propertyOf(invalid, "extensions"), "field")).toBe(
      "phone",
    );
    const locked = thrown(() => refuse("PROFILE_FIELD_LOCKED", "locked"));
    expect(extensionCodeOf(locked)).toBe("PROFILE_FIELD_LOCKED");
    expect(statusOf(locked)).toBe(403);
  });

  test("refuseCommon uses the common codes and their statuses", () => {
    const missing = thrown(() => refuseCommon("NOT_FOUND", "none"));
    expect(extensionCodeOf(missing)).toBe("NOT_FOUND");
    expect(statusOf(missing)).toBe(404);
    const stale = thrown(() => refuseCommon("CONFLICT", "stale"));
    expect(extensionCodeOf(stale)).toBe("CONFLICT");
    expect(statusOf(stale)).toBe(409);
  });
});
