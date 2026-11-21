import { describe, expect, it } from "bun:test";
import { stronger } from "./me.utils";

describe("me utils", () => {
  it("picks the stronger role", () => {
    expect(stronger("viewer", "owner")).toBe("owner");
    expect(stronger("admin", "viewer")).toBe("admin");
    expect(stronger("admin", null)).toBe("admin");
  });
});
