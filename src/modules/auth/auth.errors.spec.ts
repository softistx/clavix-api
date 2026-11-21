import { describe, expect, test } from "bun:test";
import type { GraphQLError } from "graphql";
import { z } from "zod";
import { at } from "~/body";
import {
  codeInvalid,
  codes,
  emailVerificationInvalid,
  emailVerificationThrottled,
  magicLinkDisabled,
  magicLinkInvalid,
} from "./auth.errors";

const detail = (error: GraphQLError) => ({
  code: error.extensions["code"],
  status: at(error.extensions, "http.status", z.number().optional()),
});

describe("auth errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("auth");
    expect([...codes.codes]).toEqual([
      "CLIENT_HEADER_REQUIRED",
      "CODE_INVALID",
      "EMAIL_UNVERIFIED",
      "EMAIL_VERIFICATION_INVALID",
      "EMAIL_VERIFICATION_THROTTLED",
      "MAGIC_LINK_DISABLED",
      "MAGIC_LINK_INVALID",
    ]);
  });

  test("each refusal carries its code and status", () => {
    expect(detail(codeInvalid())).toEqual({
      code: "CODE_INVALID",
      status: 401,
    });
    expect(detail(magicLinkDisabled())).toEqual({
      code: "MAGIC_LINK_DISABLED",
      status: 404,
    });
    expect(detail(magicLinkInvalid())).toEqual({
      code: "MAGIC_LINK_INVALID",
      status: 401,
    });
    expect(detail(emailVerificationInvalid())).toEqual({
      code: "EMAIL_VERIFICATION_INVALID",
      status: 400,
    });
    expect(detail(emailVerificationThrottled(30))).toEqual({
      code: "EMAIL_VERIFICATION_THROTTLED",
      status: 429,
    });
  });

  test("the e-mail verification throttle names when to retry", () => {
    expect(emailVerificationThrottled(30).extensions["retryAfter"]).toBe(30);
  });
});
