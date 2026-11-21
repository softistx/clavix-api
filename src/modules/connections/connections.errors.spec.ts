import { describe, expect, test } from "bun:test";
import { ConnectionError, codes } from "./connections.errors";

describe("connections errors", () => {
  test("a ConnectionError carries its code, field and retry delay", () => {
    const error = new ConnectionError("VERIFY_COOLDOWN", "wait", "domain", 42);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConnectionError");
    expect(error).toMatchObject({
      code: "VERIFY_COOLDOWN",
      message: "wait",
      field: "domain",
      retryAfter: 42,
    });
  });

  test("field and retry delay are optional", () => {
    const error = new ConnectionError("NOT_FOUND", "No such connection");
    expect(error.field).toBeUndefined();
    expect(error.retryAfter).toBeUndefined();
  });

  test("the module's codes keep their upper-snake values (D3)", () => {
    expect(codes.module).toBe("connections");
    expect([...codes.codes]).toEqual([
      "CONNECTION_IN_USE",
      "ISSUER_REFUSED",
      "ISSUER_UNREACHABLE",
      "SSO_REQUIRED",
    ]);
  });
});
