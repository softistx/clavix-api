import { describe, expect, test } from "bun:test";
import { pick, valuesOf } from "./consent.detail-format";

const field = {
  kind: "enum",
  values: [
    {
      value: "eur",
      label: [
        { locale: "en", text: "Euro" },
        { locale: "fr", text: "Euro (€)" },
      ],
    },
  ],
} as const;

const yes = [
  { locale: "en", text: "Yes" },
  { locale: "fr", text: "Oui" },
];

describe("pick", () => {
  test("the viewer's language, else the first translation, else the fallback", () => {
    expect(pick(yes, "fr-CA")).toBe("Oui");
    expect(pick(yes, "de")).toBe("Yes");
    expect(pick(undefined, null, "raw")).toBe("raw");
  });
});

describe("valuesOf", () => {
  test("an enum value takes its label in the viewer's language", () => {
    expect(valuesOf("eur", field, "fr")).toEqual([
      { kind: "text", text: "Euro (€)" },
    ]);
    expect(valuesOf(["eur", "usd"], field, "en")).toEqual([
      { kind: "text", text: "Euro" },
      { kind: "text", text: "usd" },
    ]);
  });

  test("a boolean and a number stay raw, with no word and no format", () => {
    expect(valuesOf(false, { kind: "boolean" }, "fr")).toEqual([
      { kind: "boolean", boolean: false },
    ]);
    expect(valuesOf(1500.5, { kind: "number" }, "fr")).toEqual([
      { kind: "number", number: 1500.5 },
    ]);
  });

  test("a value of a shape the kind does not allow has none", () => {
    expect(valuesOf({}, { kind: "string" }, "en")).toEqual([]);
    expect(valuesOf({}, field, "en")).toEqual([]);
    expect(valuesOf([], field, "en")).toEqual([]);
  });
});
