import { expect, test } from "bun:test";
import { badInput, fail } from "./errors";

test("a refusal carries its code and message", () => {
  const error = fail("NOT_FOUND", "No such tenant");
  expect(error.message).toBe("No such tenant");
  expect(error.extensions).toEqual({ code: "NOT_FOUND" });
});

test("the status and the field go in the extensions", () => {
  const error = fail("BAD_USER_INPUT", "bad", { status: 400, field: "slug" });
  expect(error.extensions).toEqual({
    code: "BAD_USER_INPUT",
    http: { status: 400 },
    field: "slug",
  });
});

test("a retry delay is in the error and in Retry-After", () => {
  const error = fail("RATE_LIMITED", "Too many requests", {
    status: 429,
    retryAfter: 12,
  });
  expect(error.extensions).toEqual({
    code: "RATE_LIMITED",
    retryAfter: 12,
    http: { status: 429, headers: { "retry-after": "12" } },
  });
});

test("headers alone leave retryAfter out, and extra fields are kept", () => {
  const error = fail("BAD_USER_INPUT", "bad", {
    headers: { "retry-after": "3" },
    extra: { missing: ["mfa"] },
  });
  expect(error.extensions).toEqual({
    code: "BAD_USER_INPUT",
    missing: ["mfa"],
    http: { headers: { "retry-after": "3" } },
  });
});

test("an extra code never overrides the refusal's own", () => {
  const error = fail("BAD_USER_INPUT", "bad", {
    extra: { code: "OTHER", missing: ["mfa"] },
  });
  expect(error.extensions).toEqual({
    code: "BAD_USER_INPUT",
    missing: ["mfa"],
  });
});

test("badInput is a 400 BAD_USER_INPUT, with the field when given", () => {
  expect(badInput("bad", "name").extensions).toEqual({
    code: "BAD_USER_INPUT",
    http: { status: 400 },
    field: "name",
  });
  expect(badInput("bad").extensions).toEqual({
    code: "BAD_USER_INPUT",
    http: { status: 400 },
  });
});
