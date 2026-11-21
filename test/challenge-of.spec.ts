import { describe, expect, test } from "bun:test";
import { ceremonyAnswer, challengeOfOptions } from "~/challenge-of";

describe("challengeOfOptions", () => {
  test("reads the challenge of the options JSON", () => {
    expect(
      challengeOfOptions(JSON.stringify({ challenge: "abc", rp: 1 })),
    ).toBe("abc");
  });

  test("throws on options that are not JSON", () => {
    expect(() => challengeOfOptions("nope")).toThrow();
  });

  test("throws on options that are not an object", () => {
    expect(() => challengeOfOptions("[1]")).toThrow();
  });
});

describe("ceremonyAnswer", () => {
  test("needs the options and the challenge", () => {
    expect(ceremonyAnswer.parse({ options: "{}", challenge: "c" })).toEqual({
      options: "{}",
      challenge: "c",
    });
    expect(() => ceremonyAnswer.parse({ options: "{}" })).toThrow();
  });
});
