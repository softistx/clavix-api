import { describe, expect, test } from "bun:test";
import {
  badDomainInput,
  codes,
  DomainError,
  domainIsPrimary,
  domainNotFound,
  domainNotVerified,
  domainTaken,
  verifyCooldown,
} from "./domains.errors";

describe("domains errors", () => {
  test("a DomainError carries its code and retry delay", () => {
    const error = new DomainError("VERIFY_COOLDOWN", "wait", 42);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DomainError");
    expect(error).toMatchObject({
      code: "VERIFY_COOLDOWN",
      message: "wait",
      retryAfter: 42,
    });
    expect(new DomainError("NOT_FOUND", "x").retryAfter).toBeUndefined();
  });

  test("each refusal has its code", () => {
    expect(domainNotFound().code).toBe("NOT_FOUND");
    expect(domainTaken().code).toBe("DOMAIN_TAKEN");
    expect(domainNotVerified().code).toBe("DOMAIN_NOT_VERIFIED");
    expect(domainIsPrimary().code).toBe("DOMAIN_PRIMARY");
    expect(badDomainInput("no").code).toBe("BAD_USER_INPUT");
    expect(verifyCooldown(7)).toMatchObject({
      code: "VERIFY_COOLDOWN",
      retryAfter: 7,
    });
  });

  test("the module's codes keep their upper-snake values (D3)", () => {
    expect(codes.module).toBe("domains");
    expect([...codes.codes]).toEqual([
      "DOMAIN_TAKEN",
      "DOMAIN_PRIMARY",
      "DOMAIN_NOT_VERIFIED",
      "VERIFY_COOLDOWN",
    ]);
  });
});
