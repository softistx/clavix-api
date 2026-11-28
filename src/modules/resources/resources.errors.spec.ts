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

  test("carries the field and the ids of the in-use codes", () => {
    const error = new CatalogError("SCOPE_IN_USE", "listed", undefined, {
      clients: ["c1"],
    });
    expect(error.extra).toEqual({ clients: ["c1"] });
    expect(new CatalogError("PERMISSION_IN_USE", "granted").extra).toBe(
      undefined,
    );
    try {
      refuse("nope", "name");
    } catch (thrown) {
      expect(thrown).toMatchObject({ field: "name" });
    }
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
