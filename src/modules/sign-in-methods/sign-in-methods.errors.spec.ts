import { describe, expect, test } from "bun:test";
import type { GraphQLError } from "graphql";
import { z } from "zod";
import { at } from "~/body";
import { codes, methodDisabled, refusal } from "./sign-in-methods.errors";

const detail = (error: GraphQLError) => ({
  code: error.extensions["code"],
  status: at(error.extensions, "http.status", z.number().optional()),
  message: error.message,
});

describe("sign-in-methods errors", () => {
  test("the module's codes keep their upper-snake values (D3)", () => {
    expect(codes.module).toBe("sign-in-methods");
    expect([...codes.codes]).toEqual([
      "SIGN_IN_METHOD_DISABLED",
      "SIGN_IN_METHOD_UNAVAILABLE",
      "SOCIAL_SECRET_REQUIRED",
      "PLATFORM_FIRST_PARTY_METHOD",
      "NO_SIGN_IN_METHOD",
    ]);
  });

  test("a refusal carries its code, message and status", () => {
    expect(detail(refusal("CONFLICT", "again", 409))).toEqual({
      code: "CONFLICT",
      status: 409,
      message: "again",
    });
  });

  test("a disabled method is SIGN_IN_METHOD_DISABLED, 404, naming the method", () => {
    expect(detail(methodDisabled("passkey"))).toEqual({
      code: "SIGN_IN_METHOD_DISABLED",
      status: 404,
      message: "Sign-in by passkey is disabled",
    });
  });
});
