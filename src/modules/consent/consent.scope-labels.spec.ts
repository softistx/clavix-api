import { describe, expect, test } from "bun:test";
import { type ScopeTexts, textOf } from "./consent.scope-labels";

const API = "https://api.example/v1";
const only = (locale: string, text: string) => [{ locale, text }];
const texts: ScopeTexts = [
  {
    name: "read",
    resource: API,
    description: [
      { locale: "fr", text: "Lire" },
      { locale: "en", text: "Read" },
      { locale: "pt-BR", text: "Ler" },
    ],
  },
  { name: "email", resource: null, description: only("fr", "Courriel") },
  { name: "email", resource: API, description: only("en", "API email") },
  { name: "write", resource: API, description: [] },
];

describe("textOf", () => {
  test("the resource's scope in the viewer's language", () => {
    expect(textOf(texts, { name: "read", resource: API }, "fr")).toBe("Lire");
    expect(textOf(texts, { name: "read", resource: API }, "en")).toBe("Read");
  });

  test("the order of the viewer's languages, then the base language, then the first translation", () => {
    const read = { name: "read", resource: API };
    expect(textOf(texts, read, "de, pt-BR;q=0.9, fr;q=0.5")).toBe("Ler");
    expect(textOf(texts, read, "fr-CA,en;q=0.8")).toBe("Lire");
    expect(textOf(texts, read, "pt")).toBe("Ler");
    expect(textOf(texts, read, "de")).toBe("Lire");
    expect(textOf(texts, read, null)).toBe("Lire");
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

  test("the standard scope on another resource, in its only language", () => {
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
