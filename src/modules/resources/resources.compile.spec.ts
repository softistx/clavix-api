import { describe, expect, test } from "bun:test";
import { compileDetailType, digestOf } from "./resources.compile";
import {
  DETAIL_LIMITS,
  type DetailFieldDefinition,
  type DetailTypeDefinition,
  detailTypeProblem,
} from "./resources.compile-rules";

const payment: DetailTypeDefinition = {
  type: "payment",
  fields: [
    { key: "amount", kind: "number", required: true, min: 0.01, max: 10000 },
    {
      key: "currency",
      kind: "enum",
      required: true,
      values: [{ value: "EUR" }, { value: "USD" }],
    },
    { key: "note", kind: "string", maxLength: 10 },
    { key: "count", kind: "integer", min: 1, max: 5 },
    { key: "express", kind: "boolean" },
    { key: "tags", kind: "string[]", max: 2, maxLength: 5 },
  ],
  actions: [{ value: "initiate" }, { value: "status" }],
};

const parse = (definition: DetailTypeDefinition, input: unknown) =>
  compileDetailType(definition).safeParse(input);
const ok = (input: unknown, definition = payment) =>
  expect(parse(definition, input).success).toBe(true);
const refused = (input: unknown, definition = payment) =>
  expect(parse(definition, input).success).toBe(false);
const base = { type: "payment", amount: 12.5, currency: "EUR" };

describe("compileDetailType", () => {
  test("accepts a detail that matches every kind", () => {
    ok({
      ...base,
      note: "hello",
      count: 3,
      express: true,
      tags: ["a", "b"],
      actions: ["initiate"],
      identifier: "acct-1",
      datatypes: ["iban"],
      locations: ["https://api.example.com/pay"],
    });
    ok(base);
  });

  test("refuses per kind", () => {
    refused({ ...base, amount: "12" }); // number
    refused({ ...base, amount: 0 }); // below min
    refused({ ...base, amount: 10001 }); // above max
    refused({ ...base, amount: Number.POSITIVE_INFINITY });
    refused({ ...base, currency: "GBP" }); // enum
    refused({ ...base, note: "x".repeat(11) }); // maxLength
    refused({ ...base, note: 5 }); // string
    refused({ ...base, count: 1.5 }); // integer
    refused({ ...base, count: 6 });
    refused({ ...base, express: "yes" }); // boolean
    refused({ ...base, tags: ["a", "b", "c"] }); // too many items
    refused({ ...base, tags: ["toolong"] }); // item length
    refused({ ...base, tags: "a" });
  });

  test("a required field is required, an optional one is not", () => {
    refused({ type: "payment", currency: "EUR" });
    refused({ type: "payment", amount: 1 });
    ok(base);
  });

  test("refuses extra keys and a wrong type literal", () => {
    refused({ ...base, extra: 1 });
    refused({ ...base, privileges: ["x"] });
    refused({ ...base, type: "other" });
    refused({ amount: 1, currency: "EUR" });
    refused("payment");
    refused(null);
  });

  test("actions are limited to the type's own, and absent when it lists none", () => {
    refused({ ...base, actions: ["delete"] });
    refused({ ...base, actions: [] });
    refused({ ...base, actions: ["initiate", "initiate", "status"] });
    refused({ type: "ping", actions: ["x"] }, { type: "ping", fields: [] });
    ok({ type: "ping" }, { type: "ping", fields: [] });
  });

  test("locations hold at most the resource, identifier and datatypes are bounded", () => {
    refused({ ...base, locations: ["a", "b"] });
    refused({ ...base, identifier: "x".repeat(DETAIL_LIMITS.identifier + 1) });
    refused({
      ...base,
      datatypes: Array(DETAIL_LIMITS.datatypes + 1).fill("a"),
    });
  });

  test("the output replaces the input and carries no foreign key", () => {
    const result = parse(payment, { ...base, express: false });
    expect(result.success && result.data).toEqual({ ...base, express: false });
  });

  test("never throws on any input", () => {
    for (const input of [
      undefined,
      1,
      [],
      {},
      { type: {} },
      Symbol.for("x"),
      () => 1,
    ]) {
      expect(() => parse(payment, input)).not.toThrow();
    }
  });

  test("the same definition gives one schema, a changed one another with its own digest", () => {
    const again = { ...payment, fields: [...payment.fields] };
    expect(compileDetailType(again)).toBe(compileDetailType(payment));
    const edited = { ...payment, fields: payment.fields.slice(0, 2) };
    const schema = compileDetailType(edited);
    expect(schema).not.toBe(compileDetailType(payment));
    expect(digestOf(schema)).not.toBe(digestOf(compileDetailType(payment)));
    expect(digestOf(compileDetailType(payment))).toBeString();
  });
});

describe("detailTypeProblem", () => {
  const withFields = (fields: DetailFieldDefinition[]) => ({
    type: "t",
    fields,
  });

  test("accepts a well-formed definition", () => {
    expect(detailTypeProblem(payment)).toBeNull();
    expect(detailTypeProblem({ type: "urn:x:pay.v1", fields: [] })).toBeNull();
  });

  test("bounds the type name", () => {
    for (const type of ["", "1abc", "a b", "a".repeat(65)]) {
      expect(detailTypeProblem({ type, fields: [] })).not.toBeNull();
    }
    expect(detailTypeProblem({ type: "a".repeat(64), fields: [] })).toBeNull();
  });

  test("bounds the fields: 16, keys of 64, no duplicate, no reserved name", () => {
    const field = (key: string): DetailFieldDefinition => ({
      key,
      kind: "boolean",
    });
    const many = Array.from({ length: 17 }, (_, i) => field(`f${i}`));
    expect(detailTypeProblem(withFields(many))).toMatch(/at most 16/);
    expect(detailTypeProblem(withFields(many.slice(0, 16)))).toBeNull();
    expect(detailTypeProblem(withFields([field("k".repeat(65))]))).toMatch(
      /64/,
    );
    expect(detailTypeProblem(withFields([field("k".repeat(64))]))).toBeNull();
    expect(detailTypeProblem(withFields([field("a"), field("a")]))).toMatch(
      /twice/,
    );
    for (const key of [
      "type",
      "locations",
      "actions",
      "identifier",
      "datatypes",
      "privileges",
    ]) {
      expect(detailTypeProblem(withFields([field(key)]))).toMatch(/reserved/);
    }
    expect(detailTypeProblem(withFields([field("1a")]))).not.toBeNull();
    expect(detailTypeProblem(withFields([field("a-b")]))).not.toBeNull();
  });

  test("bounds each kind", () => {
    const bad = (field: DetailFieldDefinition) =>
      expect(detailTypeProblem(withFields([field]))).not.toBeNull();
    bad({ key: "e", kind: "enum" });
    bad({ key: "e", kind: "enum", values: [] });
    bad({ key: "e", kind: "enum", values: [{ value: "a" }, { value: "a" }] });
    bad({
      key: "e",
      kind: "enum",
      values: Array.from({ length: 51 }, (_, i) => ({ value: `v${i}` })),
    });
    bad({ key: "n", kind: "number", min: 5, max: 1 });
    bad({ key: "n", kind: "number", min: Number.NaN });
    bad({ key: "i", kind: "integer", min: 0.5 });
    bad({ key: "b", kind: "boolean", min: 1 });
    bad({ key: "s", kind: "string", maxLength: 0 });
    bad({ key: "s", kind: "string", maxLength: 1025 });
    bad({ key: "s", kind: "string", max: 3 });
    bad({ key: "l", kind: "string[]", max: 65 });
    bad({ key: "n", kind: "number", maxLength: 3 });
    expect(detailTypeProblem({ ...payment, actions: [] })).toBeNull();
  });

  test("compileDetailType throws on a definition the check refuses", () => {
    expect(() => compileDetailType({ type: "", fields: [] })).toThrow(
      TypeError,
    );
  });
});
