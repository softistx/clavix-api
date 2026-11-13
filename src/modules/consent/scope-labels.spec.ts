import { describe, expect, test } from "bun:test";
import { localeOf, type ScopeTexts, textOf } from "./scope-labels";

const API = "https://api.example/v1";
const texts: ScopeTexts = [
  { name: "read", resource: API, description: { fr: "Lire", en: "Read" } },
  { name: "email", resource: null, description: { fr: "Courriel", en: "" } },
  { name: "email", resource: API, description: { fr: "", en: "API email" } },
  { name: "write", resource: API, description: { fr: "", en: "" } },
];

describe("localeOf", () => {
  test("French when the first preferred language is French, else English", () => {
    expect(localeOf("fr-CA,en;q=0.8")).toBe("fr");
    expect(localeOf("en,fr;q=0.8")).toBe("en");
    expect(localeOf("de")).toBe("en");
    expect(localeOf(null)).toBe("en");
  });
});

describe("textOf", () => {
  test("the resource's scope in the viewer's language", () => {
    expect(textOf(texts, { name: "read", resource: API }, "fr")).toBe("Lire");
    expect(textOf(texts, { name: "read", resource: API }, "en")).toBe("Read");
  });

  test("the resource's scope comes before the standard one of the same name", () => {
    expect(textOf(texts, { name: "email", resource: API }, "en")).toBe(
      "API email",
    );
    // The other language of the resource's scope, before the standard scope.
    expect(textOf(texts, { name: "email", resource: API }, "fr")).toBe(
      "API email",
    );
  });

  test("the standard scope on another resource, in the other language when needed", () => {
    const userinfo = "https://acme.example/userinfo";
    expect(textOf(texts, { name: "email", resource: userinfo }, "en")).toBe(
      "Courriel",
    );
  });

  test("undefined when nothing was written, or for another resource's scope", () => {
    expect(
      textOf(texts, { name: "write", resource: API }, "fr"),
    ).toBeUndefined();
    expect(
      textOf(texts, { name: "read", resource: "https://other.example" }, "fr"),
    ).toBeUndefined();
  });
});
