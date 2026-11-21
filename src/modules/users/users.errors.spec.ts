import { describe, expect, test } from "bun:test";
import { badInput, gone } from "./users.errors";

describe("users errors", () => {
  test("gone is NOT_FOUND", () => {
    expect(gone().extensions?.["code"]).toBe("NOT_FOUND");
  });

  test("badInput is a 400 BAD_USER_INPUT with its message", () => {
    const error = badInput("nope");
    expect(error.extensions?.["code"]).toBe("BAD_USER_INPUT");
    expect(error.message).toBe("nope");
  });
});
