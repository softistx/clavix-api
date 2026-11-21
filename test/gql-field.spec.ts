import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { GqlResult } from "~/gql";
import { fieldOf } from "~/gql-field";

describe("fieldOf", () => {
  const result: GqlResult = { data: { user: { id: "1" }, gone: null } };

  test("returns the field parsed by the schema", () => {
    expect(fieldOf(result, "user", z.object({ id: z.string() }))).toEqual({
      id: "1",
    });
  });

  test("throws, with the errors, on a missing or null field", () => {
    const failed: GqlResult = { data: null, errors: [{ message: "denied" }] };
    expect(() => fieldOf(failed, "user", z.unknown())).toThrow(/denied/);
    expect(() => fieldOf(result, "gone", z.unknown())).toThrow("no gone");
    expect(() => fieldOf(result, "other", z.unknown())).toThrow("no other");
  });

  test("throws when the field does not fit the schema", () => {
    expect(() => fieldOf(result, "user", z.string())).toThrow();
  });
});
