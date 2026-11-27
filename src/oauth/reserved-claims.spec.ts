import { describe, expect, test } from "bun:test";
import { RESERVED_ACCESS_TOKEN_CLAIMS } from "@softistx/janus-oauth";
import { RESERVED_CLAIMS } from "@/modules/attributes";
import { omitReserved } from "./reserved-claims";

describe("omitReserved", () => {
  test("drops the listed names and keeps the others", () => {
    const kept = omitReserved(new Set(["sub", "iss"]), {
      sub: "x",
      iss: "y",
      nick: "ada",
    });
    expect(kept).toEqual({ nick: "ada" });
  });

  test("an ID token list drops what an ID token owns", () => {
    const kept = omitReserved(new Set(RESERVED_CLAIMS), {
      nonce: "evil",
      email: "evil@x.test",
      nick: "ada",
    });
    expect(kept).toEqual({ nick: "ada" });
  });

  test("an access token list drops what an access token owns", () => {
    const kept = omitReserved(new Set(RESERVED_ACCESS_TOKEN_CLAIMS), {
      iss: "evil",
      exp: 1,
      nick: "ada",
    });
    expect(kept).toEqual({ nick: "ada" });
  });
});
