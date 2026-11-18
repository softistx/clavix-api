import { describe, expect, test } from "bun:test";
import { type DetailTexts, detailsOf } from "./detail-labels";

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
