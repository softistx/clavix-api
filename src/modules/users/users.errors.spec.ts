import { describe, expect, test } from "bun:test";
import { gone } from "./users.errors";

describe("users errors", () => {
  test("gone is NOT_FOUND", () => {
    expect(gone().extensions?.["code"]).toBe("NOT_FOUND");
  });
});
