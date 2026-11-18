import { describe, expect, test } from "bun:test";
import { type DetailTexts, detailsOf, reviewDetails } from "./detail-labels";

const texts: DetailTexts = [
  {
    type: "export",
    name: { fr: "Export", en: "Export" },
    description: { fr: "", en: "Export your data" },
    fields: [
      {
        key: "format",
        kind: "enum",
        label: { fr: "Format", en: "Format" },
        values: [{ value: "csv", label: { fr: "Tableur", en: "" } }],
      },
      { key: "tags", kind: "string[]", label: { fr: "", en: "Tags" } },
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
