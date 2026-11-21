import { describe, expect, test } from "bun:test";
import {
  checkQuery,
  checkSizes,
  clientIdOf,
  DEFAULT_GRANTS,
  MAX_QUERY,
  OFFERED_GRANTS,
  sameClient,
  usesRedirect,
} from "./clients.rules";
import type { ClientView } from "./clients.types";

const stored: ClientView = {
  clientId: "web",
  name: "Web",
  type: "public",
  redirectUris: ["https://app.example/cb"],
  grantTypes: ["authorization_code", "refresh_token"],
  createdAt: new Date("2026-11-12T00:00:00Z"),
  requirePushedAuthorizationRequests: false,
  dpopBoundAccessTokens: false,
  registration: "console",
  authorizationDetailsTypes: [],
  allowedScopes: [],
  defaultScopes: [],
};

describe("clients rules", () => {
  test("clientIdOf lowercases a name to a-z0-9-", () => {
    expect(clientIdOf("  My Web App! ")).toBe("my-web-app");
    expect(clientIdOf("!!!")).toBe("");
  });

  test("usesRedirect: only authorization_code redirects", () => {
    expect(usesRedirect(undefined)).toBe(true);
    expect(usesRedirect([...DEFAULT_GRANTS])).toBe(true);
    expect(usesRedirect(["refresh_token"])).toBe(false);
    expect(OFFERED_GRANTS).toContain("authorization_code");
  });

  test("checkSizes refuses an oversized name, list or scope set", () => {
    expect(() => checkSizes({ name: "x".repeat(101) })).toThrow("name");
    expect(() =>
      checkSizes({ redirectUris: Array(21).fill("https://a.example") }),
    ).toThrow("redirect URIs");
    expect(() => checkSizes({ detailTypes: Array(51).fill("t") })).toThrow(
      "detail types",
    );
    expect(() => checkSizes({ allowedScopes: Array(101).fill("s") })).toThrow(
      "scopes",
    );
    expect(() => checkSizes({ name: "ok" })).not.toThrow();
  });

  test("checkQuery refuses a long search", () => {
    expect(() => checkQuery("x".repeat(MAX_QUERY + 1))).toThrow("search");
    expect(() => checkQuery(undefined)).not.toThrow();
  });

  test("sameClient compares the name, type, redirect URIs and sent settings", () => {
    const input = {
      name: " Web ",
      type: "public" as const,
      redirectUris: ["https://app.example/cb"],
    };
    expect(sameClient(stored, input)).toBe(true);
    expect(sameClient(stored, { ...input, name: "Other" })).toBe(false);
    expect(sameClient(stored, { ...input, type: "confidential" })).toBe(false);
    expect(sameClient(stored, { ...input, requirePar: true })).toBe(false);
    expect(sameClient(stored, { ...input, grants: ["refresh_token"] })).toBe(
      false,
    );
  });
});
