import { describe, expect, it } from "bun:test";
import { limitOf, stronger } from "./me.utils";

describe("me utils", () => {
  it("keeps the page size within 1 and 100, 25 by default", () => {
    expect(limitOf(undefined)).toBe(25);
    expect(limitOf(0)).toBe(1);
    expect(limitOf(1000)).toBe(100);
  });

  it("picks the stronger role", () => {
    expect(stronger("viewer", "owner")).toBe("owner");
    expect(stronger("admin", "viewer")).toBe("admin");
    expect(stronger("admin", null)).toBe("admin");
  });
});
