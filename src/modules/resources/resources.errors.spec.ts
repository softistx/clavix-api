import { describe, expect, test } from "bun:test";
import { CatalogError, refuse } from "./resources.errors";

describe("CatalogError", () => {
  test("is an Error named CatalogError, with its code and message", () => {
    const error = new CatalogError("NOT_FOUND", "No such resource");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CatalogError");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("No such resource");
  });

  test("carries the in-use code of a detail type a client lists", () => {
    expect(new CatalogError("DETAIL_TYPE_IN_USE", "listed").code).toBe(
      "DETAIL_TYPE_IN_USE",
    );
  });

  test("refuse throws BAD_USER_INPUT with its message", () => {
    expect(() => refuse("nope")).toThrow(CatalogError);
    try {
      refuse("nope");
    } catch (error) {
      expect(error).toMatchObject({ code: "BAD_USER_INPUT", message: "nope" });
    }
  });
});
