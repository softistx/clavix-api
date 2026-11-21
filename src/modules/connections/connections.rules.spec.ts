import { describe, expect, test } from "bun:test";
import { ConnectionError } from "./connections.errors";
import { MAX_DOMAINS, nameOf } from "./connections.rules";

describe("connections rules", () => {
  test("a name is trimmed", () => {
    expect(nameOf("  Acme SSO ")).toBe("Acme SSO");
  });

  test("a blank or over-long name is refused on `name`", () => {
    for (const name of ["", "   ", "x".repeat(101)]) {
      expect(() => nameOf(name)).toThrow(ConnectionError);
      try {
        nameOf(name);
      } catch (error) {
        expect(error).toMatchObject({
          code: "BAD_USER_INPUT",
          field: "name",
        });
      }
    }
    expect(nameOf("x".repeat(100))).toHaveLength(100);
  });

  test("a connection holds twenty domains", () => {
    expect(MAX_DOMAINS).toBe(20);
  });
});
