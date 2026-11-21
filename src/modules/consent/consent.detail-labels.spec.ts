import { describe, expect, test } from "bun:test";
import {
  type DetailTexts,
  detailsOf,
  reviewDetails,
} from "./consent.detail-labels";

// A text in French and English; a blank language is not written.
const t = (fr: string, en: string) => [
  ...(fr === "" ? [] : [{ locale: "fr", text: fr }]),
  ...(en === "" ? [] : [{ locale: "en", text: en }]),
];

const texts: DetailTexts = [
  {
    type: "export",
    name: t("Export", "Export"),
    description: t("", "Export your data"),
    fields: [
      {
        key: "format",
        kind: "enum",
        label: t("Format", "Format"),
        values: [{ value: "csv", label: t("Tableur", "") }],
      },
      { key: "tags", kind: "string[]", label: t("", "Tags") },
    ],
  },
];

describe("detailsOf", () => {
  test("none asked, or not a JSON array, gives no block", () => {
    expect(detailsOf(null, texts, "en")).toEqual([]);
    expect(detailsOf("nope", texts, "en")).toEqual([]);
    expect(detailsOf('{"type":"export"}', texts, "en")).toEqual([]);
  });

  test("an enum shows its value's label (the other language when empty), a list its items, the common fields their words", () => {
    const json = JSON.stringify([
      {
        type: "export",
        format: "csv",
        tags: ["a", "b"],
        identifier: "acct-1",
        datatypes: ["x", "y"],
        secret: "never shown",
      },
    ]);
    expect(detailsOf(json, texts, "en")).toEqual([
      {
        type: "export",
        title: "Export",
        description: "Export your data",
        rows: [
          { label: "Format", value: "Tableur" },
          { label: "Tags", value: "a, b" },
          { label: "Identifier", value: "acct-1" },
          { label: "Data", value: "x, y" },
        ],
      },
    ]);
    expect(detailsOf(json, texts, "fr")[0]?.rows[3]).toEqual({
      label: "Données",
      value: "x, y",
    });
  });

  test("a viewer's other languages: the base language, a language none covers", () => {
    const json = JSON.stringify([
      { type: "export", identifier: "a", datatypes: ["x"] },
    ]);
    const labels = (language: string) =>
      detailsOf(json, texts, language)[0]?.rows.map((row) => row.label);
    expect(labels("fr-CA")).toEqual(["Identifiant", "Données"]);
    expect(labels("de")).toEqual(["Identifier", "Data"]);
    expect(detailsOf(json, texts, null)[0]?.title).toBe("Export");
  });

  test("booleans read yes or no, numbers use the viewer's format", () => {
    const typed: DetailTexts = [
      {
        type: "pay",
        name: t("Paiement", "Payment"),
        description: [],
        fields: [
          { key: "ok", kind: "boolean", label: t("", "Ok") },
          { key: "sum", kind: "number", label: t("", "Sum") },
        ],
      },
    ];
    const json = JSON.stringify([{ type: "pay", ok: true, sum: 1234.5 }]);
    const values = (language: string) =>
      detailsOf(json, typed, language)[0]?.rows.map((row) => row.value);
    expect(values("en")).toEqual(["Yes", "1,234.5"]);
    expect(values("fr")).toEqual(["Oui", expect.stringMatching(/^1.234,5$/)]);
  });

  test("a field with nothing to show has no row", () => {
    const json = JSON.stringify([{ type: "export", tags: [], format: {} }]);
    expect(detailsOf(json, texts, "en")[0]?.rows).toEqual([]);
  });

  test("a type the tenant no longer stores shows its name, and an unknown field is never shown", () => {
    const json = JSON.stringify([{ type: "gone", amount: 1, actions: ["go"] }]);
    expect(detailsOf(json, texts, "en")).toEqual([
      {
        type: "gone",
        title: "gone",
        description: "",
        rows: [{ label: "Actions", value: "go" }],
      },
    ]);
  });
});

describe("reviewDetails: complete", () => {
  const complete = (details: unknown) =>
    reviewDetails(JSON.stringify(details), texts, "en").complete;

  test("none asked is complete, a described detail too", () => {
    expect(reviewDetails(null, texts, "en").complete).toBe(true);
    expect(
      complete([
        { type: "export", format: "csv", tags: ["a"], identifier: "x" },
      ]),
    ).toBe(true);
  });

  test("a type the tenant no longer stores, a key it no longer defines or an enum value it no longer lists is not", () => {
    expect(complete([{ type: "gone" }])).toBe(false);
    expect(complete([{ type: "export", removed: 1 }])).toBe(false);
    expect(complete([{ type: "export", privileges: ["p"] }])).toBe(false);
    expect(complete([{ type: "export", format: "xml" }])).toBe(false);
    expect(complete([{ type: "export", actions: ["read"] }])).toBe(false);
  });

  test("an entry that is not a typed object, or unreadable JSON, is not", () => {
    expect(complete([{ type: "export" }, 3])).toBe(false);
    expect(complete([{ nope: true }])).toBe(false);
    expect(reviewDetails("nope", texts, "en").complete).toBe(false);
  });
});
