import { describe, expect, test } from "bun:test";
import { scopeClaimsOf } from "./issuers-oidc";

const STANDARD = scopeClaimsOf({});

describe("scopeClaimsOf", () => {
  test("keeps roles under openid and adds the attribute scopes", () => {
    expect(scopeClaimsOf({ read: ["nick"], profile: ["age"] })).toEqual({
      ...STANDARD,
      read: ["nick"],
      profile: [...(STANDARD["profile"] ?? []), "age"],
    });
  });

  test("an attribute on a standard scope keeps the standard claims, picture included", () => {
    expect(scopeClaimsOf({ profile: ["age"] })["profile"]).toEqual(
      expect.arrayContaining(["name", "picture", "age"]),
    );
    expect(scopeClaimsOf({ email: ["tier"] })["email"]).toEqual(
      expect.arrayContaining(["email", "email_verified", "tier"]),
    );
  });

  test("a scope listed in both releases both lists, without repeats", () => {
    expect(scopeClaimsOf({ openid: ["nick", "roles"] })["openid"]).toEqual([
      "roles",
      "nick",
    ]);
  });

  test("a reserved claim name is never released by an attribute scope", () => {
    expect(scopeClaimsOf({ read: ["nonce", "email", "nick"] })).toEqual({
      ...STANDARD,
      read: ["nick"],
    });
  });

  test("a tenant with no attribute scope keeps the base table", () => {
    expect(scopeClaimsOf({})["openid"]).toEqual(["roles"]);
    expect(scopeClaimsOf({})["profile"]).toContain("picture");
  });
});
