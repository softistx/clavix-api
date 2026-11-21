import { describe, expect, test } from "bun:test";
import { canon, cleanDetailType } from "./resources.detail-rules";
import { CatalogError } from "./resources.errors";
import { MAX_LABEL } from "./resources.rules";
import type { DetailTypeDraft } from "./resources.types";

const draft = (extra: Partial<DetailTypeDraft> = {}): DetailTypeDraft => ({
  type: " payment ",
  name: { en: " Payment " },
  fields: [
    {
      key: "amount",
      kind: "number",
      label: { en: "Amount" },
      required: true,
      min: 1,
    },
    {
      key: "currency",
      kind: "enum",
      values: [{ value: "EUR", label: { fr: "Euro" } }],
    },
  ],
  actions: [{ value: "initiate" }],
  ...extra,
});

describe("cleanDetailType", () => {
  test("trims the texts, fills a missing language with empty and keeps the bounds", () => {
    const clean = cleanDetailType(draft());
    expect(clean.type).toBe("payment");
    expect(clean.name).toEqual({ fr: "", en: "Payment" });
    expect(clean.description).toEqual({ fr: "", en: "" });
    expect(clean.fields[0]).toEqual({
      key: "amount",
      kind: "number",
      label: { fr: "", en: "Amount" },
      required: true,
      min: 1,
    });
    expect(clean.fields[1]?.required).toBe(false);
    expect(clean.fields[1]?.values).toEqual([
      { value: "EUR", label: { fr: "Euro", en: "" } },
    ]);
    expect(clean.actions).toEqual([
      { value: "initiate", label: { fr: "", en: "" } },
    ]);
  });

  test("leaves actions out when the draft has none", () => {
    expect(cleanDetailType(draft({ actions: undefined }))).not.toHaveProperty(
      "actions",
    );
  });

  test("refuses a type with no name in any language", () => {
    expect(() => cleanDetailType(draft({ name: {} }))).toThrow(/needs a name/);
  });

  test("refuses an over-long label", () => {
    expect(() =>
      cleanDetailType(draft({ name: { en: "x".repeat(MAX_LABEL + 1) } })),
    ).toThrow(CatalogError);
  });
});

describe("canon", () => {
  test("is equal for equal definitions and differs on any change", () => {
    const a = cleanDetailType(draft());
    expect(canon(a)).toBe(canon(cleanDetailType(draft())));
    expect(canon(a)).not.toBe(
      canon(cleanDetailType(draft({ name: { en: "Other" } }))),
    );
    expect(canon(a)).not.toBe(
      canon(cleanDetailType(draft({ actions: undefined }))),
    );
  });
});
