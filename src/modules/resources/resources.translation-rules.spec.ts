import { describe, expect, test } from "bun:test";
import { CatalogError } from "./resources.errors";
import {
  canonTranslations,
  cleanTranslations,
  MAX_TRANSLATIONS,
  mergeTranslations,
} from "./resources.translation-rules";

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return error.message;
    throw error;
  }
  return "";
};

describe("cleanTranslations", () => {
  test("trims, canonicalizes the locale and drops a blank text", () => {
    expect(
      cleanTranslations(
        [
          { locale: "fr-ca", text: "  Lire  " },
          { locale: "en", text: "   " },
        ],
        300,
        "a description",
      ),
    ).toEqual([{ locale: "fr-CA", text: "Lire" }]);
  });

  test("nothing sent is an empty list", () => {
    expect(cleanTranslations(undefined, 300, "a description")).toEqual([]);
    expect(cleanTranslations(null, 300, "a description")).toEqual([]);
  });

  test("refuses a tag that is not BCP 47", () => {
    expect(
      refusal(() =>
        cleanTranslations([{ locale: "not a tag", text: "x" }], 10, "a label"),
      ),
    ).toContain("is not a language tag");
  });

  test("refuses a locale given twice, whatever its case", () => {
    expect(
      refusal(() =>
        cleanTranslations(
          [
            { locale: "en", text: "a" },
            { locale: "EN", text: "b" },
          ],
          10,
          "a label",
        ),
      ),
    ).toBe("a label is given twice in en");
  });

  test("bounds each text", () => {
    expect(
      refusal(() =>
        cleanTranslations([{ locale: "en", text: "abcdef" }], 5, "a label"),
      ),
    ).toBe("a label has at most 5 characters");
  });

  test("holds at most 30 languages", () => {
    const many = Array.from({ length: MAX_TRANSLATIONS + 1 }, (_, i) => ({
      locale: `${String.fromCharCode(97 + Math.floor(i / 26))}b${String.fromCharCode(97 + (i % 26))}`,
      text: "t",
    }));
    expect(refusal(() => cleanTranslations(many, 10, "a label"))).toBe(
      `a label has at most ${MAX_TRANSLATIONS} languages`,
    );
  });
});

describe("mergeTranslations", () => {
  const stored = [
    { locale: "en", text: "Payment" },
    { locale: "fr", text: "Paiement" },
  ];

  test("sets or replaces the given locales and keeps the others", () => {
    expect(
      mergeTranslations(
        stored,
        [
          { locale: "fr", text: "Règlement" },
          { locale: "de", text: "Zahlung" },
        ],
        64,
        "a name",
      ),
    ).toEqual([
      { locale: "en", text: "Payment" },
      { locale: "fr", text: "Règlement" },
      { locale: "de", text: "Zahlung" },
    ]);
  });

  test("a blank text removes that locale only", () => {
    expect(
      mergeTranslations(stored, [{ locale: "fr", text: " " }], 64, "a name"),
    ).toEqual([{ locale: "en", text: "Payment" }]);
  });

  test("nothing sent keeps the stored text", () => {
    expect(mergeTranslations(stored, undefined, 64, "a name")).toEqual(stored);
    expect(mergeTranslations(stored, null, 64, "a name")).toEqual(stored);
  });

  test("an empty list changes nothing", () => {
    expect(mergeTranslations(stored, [], 64, "a name")).toEqual(stored);
  });
});

describe("canonTranslations", () => {
  test("does not depend on the order or the case of the locales", () => {
    expect(
      canonTranslations([
        { locale: "fr", text: "a" },
        { locale: "en", text: "b" },
      ]),
    ).toEqual(
      canonTranslations([
        { locale: "EN", text: "b" },
        { locale: "fr", text: "a" },
      ]),
    );
  });
});
