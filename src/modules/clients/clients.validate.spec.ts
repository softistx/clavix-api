import { describe, expect, test } from "bun:test";
import type { OAuthClientRecord } from "@softistx/janus-oauth";
import { CliInputError } from "@/shared/cli";
import {
  checkGrants,
  checkType,
  machineScopesOf,
  validate,
} from "./clients.validate";

const base = {
  tenant: "acme",
  name: "Web",
  redirectUris: ["https://a.example/cb"],
};
const stored = (extra: Partial<OAuthClientRecord> = {}): OAuthClientRecord => ({
  id: "web",
  name: "Web",
  redirectUris: ["https://a.example/cb"],
  source: "registered",
  createdAt: new Date("2026-11-12T00:00:00Z"),
  expiresAt: null,
  ...extra,
});

describe("clients validate", () => {
  test("validate derives the id and cleans the lists", () => {
    const checked = validate({
      ...base,
      redirectUris: ["https://a.example/cb", "https://a.example/cb"],
      allowedScopes: [" read ", "read"],
    });
    expect(checked.clientId).toBe("web");
    expect(checked.redirectUris).toHaveLength(1);
    expect(checked.allowedScopes).toEqual(["read"]);
  });

  test("validate refuses a blank name, a bad id, a bad grant", () => {
    expect(() => validate({ ...base, name: " " })).toThrow(CliInputError);
    expect(() => validate({ ...base, clientId: "-x" })).toThrow("client id");
    expect(() => validate({ ...base, grants: ["nope"] })).toThrow("offered");
    expect(() => validate({ ...base, grants: ["refresh_token"] })).toThrow(
      "first token",
    );
    expect(() => validate({ ...base, allowedScopes: ["a b"] })).toThrow(
      "not a scope",
    );
  });

  test("checkGrants needs a redirect URI for a redirecting client", () => {
    const checked = validate({ ...base, redirectUris: [] });
    expect(() => checkGrants(checked, false, null)).toThrow("redirect URI");
  });

  test("machineScopesOf keeps a ceiling and refuses scopes without the grant", () => {
    const withScopes = validate({
      ...base,
      allowedScopes: ["r"],
      defaultScopes: ["w"],
    });
    expect(() => machineScopesOf(withScopes, false, null)).toThrow("belong to");
    expect(() => machineScopesOf(withScopes, true, null)).toThrow(
      "must be allowed",
    );
    expect(machineScopesOf(validate(base), false, null)).toEqual({
      allowed: [],
      default: [],
    });
  });

  test("checkType keeps a client's type and refuses rotating a public one", () => {
    expect(() =>
      checkType("web", false, stored({ secretHash: "h" }), false),
    ).toThrow("confidential");
    expect(() => checkType("web", true, stored(), false)).toThrow(
      "public client",
    );
    expect(() => checkType("web", false, null, true)).toThrow("rotate");
    expect(() =>
      checkType("web", true, stored({ secretHash: "h" }), true),
    ).not.toThrow();
  });
});
