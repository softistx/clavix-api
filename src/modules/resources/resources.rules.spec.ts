import { describe, expect, test } from "bun:test";
import { CliInputError } from "@/shared/cli";
import { scopeDoc } from "~/resource-docs";
import { CatalogError } from "./resources.errors";
import {
  checkCanonicalRegistration,
  checkRegistration,
  checkResourceUri,
  checkScopeName,
  cleanClaims,
  cleanName,
  isOidcScope,
  MAX_NAME,
  OIDC_SCOPES,
  resourceUriProblem,
  sameScopeDefinition,
  sameUri,
  scopeNameProblem,
} from "./resources.rules";

describe("resourceUriProblem loopback hosts", () => {
  test.each([
    "http://localhost:5299/api",
    "http://127.0.0.1:5299/api",
    "http://[::1]:5299/api",
    "http://console.clavix.localhost:5299/api",
    "http://clavix.localhost/api",
    "http://LOCALHOST./api",
  ])("allows http on %s", (uri) => {
    expect(resourceUriProblem(uri)).toBeNull();
  });

  test.each([
    "http://example.com/api",
    "http://notlocalhost/api",
    "http://localhost.evil.com/api",
    "http://evil.com/localhost",
  ])("refuses http on %s", (uri) => {
    expect(resourceUriProblem(uri)).toContain("must be https");
  });

  test("still allows https anywhere", () => {
    expect(resourceUriProblem("https://api.example.com/x")).toBeNull();
  });
});

describe("scope and resource names", () => {
  test("scopeNameProblem accepts OAuth scope tokens only", () => {
    expect(scopeNameProblem("read:all")).toBeNull();
    expect(scopeNameProblem("has space")).toContain("printable ASCII");
    expect(scopeNameProblem('quo"te')).toContain("printable ASCII");
  });

  test("isOidcScope knows the five standard scopes", () => {
    expect(OIDC_SCOPES.every(isOidcScope)).toBe(true);
    expect(isOidcScope("phone")).toBe(true);
    expect(isOidcScope("address")).toBe(true);
    expect(isOidcScope("read")).toBe(false);
  });

  test("cleanName trims, and refuses a blank or an over-long name", () => {
    expect(cleanName("  Pay  ")).toBe("Pay");
    expect(() => cleanName("  ")).toThrow(CatalogError);
    expect(() => cleanName("x".repeat(MAX_NAME + 1))).toThrow(/at most/);
  });

  test("cleanClaims deduplicates and bounds the claims", () => {
    expect(cleanClaims([" a ", "a", "b"])).toEqual(["a", "b"]);
    expect(cleanClaims(undefined)).toEqual([]);
    expect(() => cleanClaims(["x".repeat(MAX_NAME + 1)])).toThrow(CatalogError);
    expect(() =>
      cleanClaims(Array.from({ length: 51 }, (_, i) => `c${i}`)),
    ).toThrow(CatalogError);
  });

  test("checkScopeName trims and refuses a blank, long or malformed name", () => {
    expect(checkScopeName(" read ")).toBe("read");
    expect(() => checkScopeName(" ")).toThrow(/needs a name/);
    expect(() => checkScopeName("x".repeat(MAX_NAME + 1))).toThrow(/at most/);
    expect(() => checkScopeName("a b")).toThrow(/printable ASCII/);
  });

  test("sameScopeDefinition compares texts and claims, not their order", () => {
    const stored = scopeDoc({
      description: [
        { locale: "fr", text: "f" },
        { locale: "en", text: "e" },
      ],
      claims: ["a", "b"],
    });
    const same = [
      { locale: "en", text: "e" },
      { locale: "fr", text: "f" },
    ];
    expect(sameScopeDefinition(stored, same, ["b", "a"])).toBe(true);
    expect(
      sameScopeDefinition(stored, [{ locale: "fr", text: "f" }], ["a", "b"]),
    ).toBe(false);
    expect(sameScopeDefinition(stored, same, ["a"])).toBe(false);
  });
});

describe("resource URIs of the console", () => {
  const userinfo = "https://acme.clavix.test/userinfo";

  test("checkResourceUri returns the trimmed canonical URI", () => {
    expect(checkResourceUri(" https://api.example/v1 ", userinfo)).toBe(
      "https://api.example/v1",
    );
  });

  test("refuses a bad, non canonical or built-in URI", () => {
    expect(() => checkResourceUri("nope", userinfo)).toThrow(/absolute/);
    expect(() => checkResourceUri("https://API.example/v1", userinfo)).toThrow(
      /canonical form/,
    );
    expect(() => checkResourceUri("https://api.example", userinfo)).toThrow(
      /write it as https:\/\/api.example\//,
    );
    expect(() => checkResourceUri(userinfo, userinfo)).toThrow(/userinfo/);
  });

  test("sameUri reads two spellings as one URL", () => {
    expect(sameUri("https://A.example:443/x", "https://a.example/x")).toBe(
      true,
    );
    expect(sameUri("https://a.example/x", "https://a.example/y")).toBe(false);
  });
});

describe("script registrations", () => {
  const input = {
    tenant: "acme",
    uri: "https://api.example/v1",
    scopes: ["r"],
  };

  test("checkRegistration defaults the name to the host and dedupes scopes", () => {
    expect(checkRegistration({ ...input, scopes: ["r", " r ", "w"] })).toEqual({
      uri: input.uri,
      name: "api.example",
      scopes: ["r", "w"],
    });
  });

  test("checkRegistration refuses with a CliInputError", () => {
    expect(() => checkRegistration({ ...input, uri: "nope" })).toThrow(
      CliInputError,
    );
    expect(() => checkRegistration({ ...input, scopes: [] })).toThrow(
      /at least one scope/,
    );
    expect(() => checkRegistration({ ...input, scopes: ["a b"] })).toThrow(
      CliInputError,
    );
    expect(() => checkRegistration({ ...input, name: " " })).toThrow(
      /needs a name/,
    );
  });

  test("checkCanonicalRegistration refuses the userinfo URL and a bare origin", () => {
    expect(() =>
      checkCanonicalRegistration("https://api.example/v1", "https://u/x"),
    ).not.toThrow();
    expect(() =>
      checkCanonicalRegistration("https://u/x", "https://u/x"),
    ).toThrow(/userinfo/);
    expect(() =>
      checkCanonicalRegistration("https://api.example", "https://u/x"),
    ).toThrow(/canonical form/);
  });
});
