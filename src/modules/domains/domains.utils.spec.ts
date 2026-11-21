import { describe, expect, test } from "bun:test";
import { mintToken } from "./domains.utils";

describe("mintToken", () => {
  test("is unguessable and distinct", () => {
    const a = mintToken();
    expect(a).toStartWith("clavix-verify=");
    expect(a.length).toBeGreaterThan(40);
    expect(mintToken()).not.toBe(a);
  });
});
