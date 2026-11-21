import { describe, expect, test } from "bun:test";
import { BrandingConflictError, codes } from "./branding.errors";

describe("branding errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("branding");
    expect([...codes.codes]).toEqual(["BRANDING_CONTRAST"]);
  });

  test("a lost race is a CONFLICT that says to read and try again", () => {
    const error = new BrandingConflictError();
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("try again");
  });
});
