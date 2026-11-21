import { describe, expect, test } from "bun:test";
import {
  badAgentsInput,
  policyConflict,
  tenantNotFound,
} from "./oauth-policy.errors";

const shape = (error: ReturnType<typeof tenantNotFound>) => ({
  message: error.message,
  code: error.extensions["code"],
  status: (error.extensions["http"] as { status?: number }).status,
});

describe("oauth policy errors", () => {
  test("keep their code, message and status", () => {
    expect(shape(tenantNotFound())).toEqual({
      message: "No such tenant",
      code: "NOT_FOUND",
      status: 404,
    });
    expect(shape(badAgentsInput("host is wrong"))).toEqual({
      message: "host is wrong",
      code: "BAD_USER_INPUT",
      status: 400,
    });
    expect(shape(policyConflict())).toEqual({
      message:
        "The OAuth policy was changed at the same time; read it and try again",
      code: "CONFLICT",
      status: 409,
    });
  });
});
