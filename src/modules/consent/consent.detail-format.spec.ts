import { describe, expect, test } from "bun:test";
import { COMMON, formatted, pick } from "./consent.detail-format";

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

describe("pick", () => {
  test("the viewer's language, else the first translation, else the fallback", () => {
    expect(pick(COMMON.yes, "fr-CA")).toBe("Oui");
    expect(pick(COMMON.yes, "de")).toBe("Yes");
    expect(pick(undefined, null, "raw")).toBe("raw");
  });
});

describe("formatted", () => {
  test("an enum value takes its label in the viewer's language", () => {
    expect(formatted("eur", field, "fr")).toBe("Euro (€)");
    expect(formatted(["eur", "usd"], field, "en")).toBe("Euro, usd");
  });

  test("a boolean is yes or no in the viewer's language", () => {
    expect(formatted(false, { kind: "boolean" }, "fr")).toBe("Non");
  });

  test("a number follows the viewer's language, English without one", () => {
    const plain = { kind: "number" } as const;
    expect(formatted(1500.5, plain, "en-US")).toBe("1,500.5");
    expect(formatted(1500.5, plain, null)).toBe("1,500.5");
    expect(formatted(1500.5, plain, "*")).toBe("1,500.5");
  });
});
