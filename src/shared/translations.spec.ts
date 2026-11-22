import { describe, expect, test } from "bun:test";
import {
  acceptedLocales,
  canonicalLocale,
  pickTranslation,
  type Translation,
} from "./translations";

const texts: Translation[] = [
  { locale: "en", text: "Read" },
  { locale: "fr", text: "Lire" },
  { locale: "pt-BR", text: "Ler" },
];

describe("canonicalLocale", () => {
  test("writes a tag in its canonical case and refuses what is no tag", () => {
    expect(canonicalLocale("fr-ca")).toBe("fr-CA");
    expect(canonicalLocale("not a tag")).toBeUndefined();
    expect(canonicalLocale("")).toBeUndefined();
  });
});

describe("acceptedLocales", () => {
  test("orders by quality, then by position", () => {
    expect(acceptedLocales("en;q=0.5, fr-CA, de;q=0.5")).toEqual([
      "fr-CA",
      "en",
      "de",
    ]);
  });

  test("drops the wildcard, a zero quality and a bad tag", () => {
    expect(acceptedLocales("*, de;q=0, x y, fr")).toEqual(["fr"]);
    expect(acceptedLocales(null)).toEqual([]);
    expect(acceptedLocales("")).toEqual([]);
  });
});

describe("pickTranslation", () => {
  test("takes the viewer's language, in the order asked", () => {
    expect(pickTranslation(texts, "fr")).toBe("Lire");
    expect(pickTranslation(texts, "de, en;q=0.5, fr;q=0.8")).toBe("Lire");
    expect(pickTranslation(texts, "pt-BR")).toBe("Ler");
  });

  test("falls back to the base language, either way", () => {
    expect(pickTranslation(texts, "fr-CA")).toBe("Lire");
    expect(pickTranslation(texts, "pt")).toBe("Ler");
  });

  test("falls back to the first stored translation", () => {
    expect(pickTranslation(texts, "de")).toBe("Read");
    expect(pickTranslation(texts, null)).toBe("Read");
    expect(pickTranslation([{ locale: "ja", text: "x" }], "en")).toBe("x");
  });

  test("skips a blank text and answers nothing for an empty list", () => {
    expect(pickTranslation([{ locale: "fr", text: "" }], "fr")).toBeUndefined();
    expect(pickTranslation([], "fr")).toBeUndefined();
  });
});
