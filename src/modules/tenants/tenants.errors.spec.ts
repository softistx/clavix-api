import { describe, expect, test } from "bun:test";
import {
  codes,
  InvalidSlugError,
  PlatformTenantProtectedError,
  SlugTakenError,
  TenantInputError,
} from "./tenants.errors";

describe("tenants errors", () => {
  test.each([
    [InvalidSlugError, "InvalidSlugError"],
    [SlugTakenError, "SlugTakenError"],
    [TenantInputError, "TenantInputError"],
    [PlatformTenantProtectedError, "PlatformTenantProtectedError"],
  ])("%p is an Error named %p", (Class, name) => {
    const error = new Class("why");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.message).toBe("why");
  });

  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("tenants");
    expect([...codes.codes]).toEqual([
      "SLUG_TAKEN",
      "PLATFORM_TENANT_PROTECTED",
      "QUOTA_EXCEEDED",
      "TENANT_SUSPENDED",
    ]);
  });
});
