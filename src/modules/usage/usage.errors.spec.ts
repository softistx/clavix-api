import { describe, expect, test } from "bun:test";
import { QuotaExceededError } from "./usage.errors";

describe("QuotaExceededError", () => {
  test("names the quota and the key", () => {
    const error = new QuotaExceededError("clients", 3);
    expect(error.key).toBe("clients");
    expect(error.quota).toBe(3);
    expect(error.name).toBe("QuotaExceededError");
    expect(error.message).toBe(
      "The plan allows 3 clients; the quota is reached",
    );
  });
});
