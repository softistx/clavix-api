import { expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { janusMasking } from "./plugin";

// An unexpected resolver error must not reach the client in production mode
// (janus-graphql 0.24.2 fixed `janusMaskError()` leaking it under envelop 6).
test("an unexpected error is masked in production mode", () => {
  const original = new GraphQLError("db password is hunter2", {
    originalError: new Error("db password is hunter2"),
  });
  const masked = janusMasking.maskError(original, "Unexpected error.", false);
  expect(JSON.stringify(masked)).not.toContain("hunter2");
  expect((masked as Error).message).toBe("Unexpected error.");
});
