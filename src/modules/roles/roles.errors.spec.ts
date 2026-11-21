import { describe, expect, test } from "bun:test";
import { instance } from "~/narrow";
import {
  codes,
  conflict,
  managedRefusal,
  RolesError,
  refuse,
} from "./roles.errors";

describe("roles errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("roles");
    expect([...codes.codes]).toEqual(["ROLE_MANAGED"]);
  });

  test("refuse throws a RolesError with the code and message", () => {
    let thrown: unknown;
    try {
      refuse("NOT_FOUND", "No such role");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RolesError);
    const refused = instance(thrown, RolesError);
    expect(refused.code).toBe("NOT_FOUND");
    expect(refused.message).toBe("No such role");
  });

  test("a managed role and a taken name have their own code", () => {
    expect(managedRefusal("admin").code).toBe("ROLE_MANAGED");
    expect(managedRefusal("admin").message).toContain('"admin"');
    expect(conflict("admin").code).toBe("CONFLICT");
    expect(conflict("admin").message).toContain('"admin"');
  });
});
