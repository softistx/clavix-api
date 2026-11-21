import { describe, expect, test } from "bun:test";
import {
  answerBody,
  deviceCodesBody,
  idTokenBody,
  parBody,
  recordBody,
} from "~/oauth-bodies";

describe("oauth bodies", () => {
  test("recordBody takes any object and refuses an array", () => {
    expect(recordBody.parse({ a: 1 })).toEqual({ a: 1 });
    expect(() => recordBody.parse([1])).toThrow();
  });

  test("deviceCodesBody needs both codes", () => {
    expect(
      deviceCodesBody.parse({ device_code: "d", user_code: "u" }).user_code,
    ).toBe("u");
    expect(() => deviceCodesBody.parse({ device_code: "d" })).toThrow();
  });

  test("parBody needs the request uri", () => {
    expect(parBody.parse({ request_uri: "urn:x" }).request_uri).toBe("urn:x");
    expect(() => parBody.parse({})).toThrow();
  });

  test("idTokenBody needs the ID token", () => {
    expect(idTokenBody.parse({ id_token: "t" }).id_token).toBe("t");
    expect(() => idTokenBody.parse({ access_token: "a" })).toThrow();
  });

  test("answerBody reads a success or a refusal, every field optional", () => {
    expect(answerBody.parse({})).toEqual({});
    expect(
      answerBody.parse({ access_token: "a", id_token: null }),
    ).toMatchObject({ access_token: "a", id_token: null });
    expect(
      answerBody.parse({ error: "invalid_grant", error_description: "d" }),
    ).toMatchObject({ error: "invalid_grant", error_description: "d" });
    expect(() => answerBody.parse({ expires_in: "1" })).toThrow();
  });
});
