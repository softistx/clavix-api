import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { instance } from "~/narrow";
import {
  asPasskeyInvalid,
  codes,
  passkeyInvalid,
  passkeyThrottled,
} from "./passkeys.errors";

const refused = (code: string) =>
  new GraphQLError("no", { extensions: { code } });

describe("passkeys errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("passkeys");
    expect([...codes.codes]).toEqual(["PASSKEY_INVALID", "PASSKEY_THROTTLED"]);
  });

  test("a refusal is a 401 and a throttle a 429 with Retry-After", () => {
    expect(passkeyInvalid().extensions["http"]).toEqual({ status: 401 });
    expect(passkeyThrottled(7).extensions["http"]).toEqual({
      status: 429,
      headers: { "retry-after": "7" },
    });
  });

  test("asPasskeyInvalid answers janus's refusals as PASSKEY_INVALID", async () => {
    for (const code of [
      "CREDENTIALS_INVALID",
      "TOKEN_SPENT",
      "USER_INACTIVE",
    ]) {
      const error = await asPasskeyInvalid(() =>
        Promise.reject(refused(code)),
      ).catch((caught: unknown) => caught);
      expect(instance(error, GraphQLError).extensions["code"]).toBe(
        "PASSKEY_INVALID",
      );
    }
  });

  test("asPasskeyInvalid leaves a store failure and a success alone", async () => {
    const store = refused("STORE_FAILED");
    await expect(asPasskeyInvalid(() => Promise.reject(store))).rejects.toBe(
      store,
    );
    expect(await asPasskeyInvalid(async () => 7)).toBe(7);
  });
});
