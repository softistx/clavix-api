import { describe, expect, test } from "bun:test";
import { scopeClaimsOf } from "./issuers-oidc";

describe("scopeClaimsOf", () => {
  test("keeps roles under openid and adds the attribute scopes", () => {
    expect(scopeClaimsOf({ read: ["nick"], profile: ["age"] })).toEqual({
      openid: ["roles"],
      read: ["nick"],
      profile: ["age"],
    });
  });

  test("a scope listed in both releases both lists, without repeats", () => {
    expect(scopeClaimsOf({ openid: ["nick", "roles"] })).toEqual({
      openid: ["roles", "nick"],
    });
  });

  test("a tenant with no attribute scope keeps the base table", () => {
    expect(scopeClaimsOf({})).toEqual({ openid: ["roles"] });
  });
});
