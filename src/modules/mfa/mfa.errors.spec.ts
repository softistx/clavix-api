import { describe, expect, test } from "bun:test";
import { codes, secondFactorDisabled } from "./mfa.errors";

describe("mfa errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("mfa");
    expect([...codes.codes]).toEqual(["SECOND_FACTOR_DISABLED"]);
  });

  test("a disabled factor is a 403 with its code", () => {
    const error = secondFactorDisabled();
    expect(error.extensions["code"]).toBe("SECOND_FACTOR_DISABLED");
    expect(error.extensions["http"]).toEqual({ status: 403 });
  });
});
