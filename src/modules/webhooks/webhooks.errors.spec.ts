import { describe, expect, test } from "bun:test";
import { WebhookError } from "./webhooks.errors";

describe("WebhookError", () => {
  test("is an Error named WebhookError, with its code and message", () => {
    const error = new WebhookError("NOT_FOUND", "No such webhook endpoint");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WebhookError");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("No such webhook endpoint");
    expect(error.field).toBeUndefined();
  });

  test("names the field a refusal is about", () => {
    const error = new WebhookError("BAD_USER_INPUT", "Bad", "url");
    expect(error.field).toBe("url");
  });
});
