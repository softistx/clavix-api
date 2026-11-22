import { describe, expect, test } from "bun:test";
import { RESERVED_ACCESS_TOKEN_CLAIMS } from "@softistx/janus-oauth";
import { extensionCodeOf } from "@/shared/errors";
import {
  checkBehaviour,
  cleanKey,
  cleanLabel,
  cleanOptions,
  cleanUnit,
  mergedLabel,
  RESERVED_CLAIMS,
  removedOptionKeys,
} from "./attributes.rules";

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return String(extensionCodeOf(error));
  }
  return undefined;
};

const label = [{ locale: "en", text: "L" }];
const base = {
  family: "USER",
  type: "STRING",
  unique: false,
  required: false,
  userEditable: false,
  emission: null,
  options: [],
} as const;

describe("keys", () => {
  test("a valid key is trimmed; a bad one is invalid", () => {
    expect(cleanKey(" shoe_size ")).toBe("shoe_size");
    for (const bad of [
      "",
      "a",
      "1abc",
      "Abc",
      "a-b",
      "a b",
      `a${"b".repeat(64)}`,
    ]) {
      expect(code(() => cleanKey(bad))).toBe("ATTRIBUTE_KEY_INVALID");
    }
    expect(cleanKey(`a${"b".repeat(63)}`)).toHaveLength(64);
  });

  test("a reserved claim is refused", () => {
    for (const reserved of [
      "sub",
      "email",
      "roles",
      "tenant",
      "scope",
      "iss",
    ]) {
      expect(code(() => cleanKey(reserved))).toBe("ATTRIBUTE_KEY_RESERVED");
    }
  });

  test("the reserved list holds janus's reserved access-token claims", () => {
    for (const claim of RESERVED_ACCESS_TOKEN_CLAIMS) {
      expect(RESERVED_CLAIMS).toContain(claim);
    }
  });
});

describe("labels, units and options", () => {
  test("a label needs a language and merges", () => {
    expect(code(() => cleanLabel([]))).toBe("BAD_USER_INPUT");
    expect(cleanLabel([{ locale: "en", text: " A " }])).toEqual([
      { locale: "en", text: "A" },
    ]);
    expect(
      mergedLabel(label, [{ locale: "fr", text: "F" }]).map((t) => t.locale),
    ).toEqual(["en", "fr"]);
    expect(code(() => mergedLabel(label, [{ locale: "en", text: " " }]))).toBe(
      "BAD_USER_INPUT",
    );
    expect(mergedLabel(label, undefined)).toEqual(label);
  });

  test("a unit is trimmed, blank is none, long is refused", () => {
    expect(cleanUnit(" kg ")).toBe("kg");
    expect(cleanUnit("  ")).toBeNull();
    expect(cleanUnit(null)).toBeNull();
    expect(cleanUnit(undefined)).toBeNull();
    expect(code(() => cleanUnit("x".repeat(21)))).toBe("BAD_USER_INPUT");
  });

  test("options are bounded, valid, unique and labelled", () => {
    expect(cleanOptions(undefined)).toEqual([]);
    expect(cleanOptions([{ key: " a-1 ", label }])).toEqual([
      { key: "a-1", label },
    ]);
    expect(code(() => cleanOptions([{ key: "A", label }]))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      code(() =>
        cleanOptions([
          { key: "a", label },
          { key: "a", label },
        ]),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(code(() => cleanOptions([{ key: "a", label: [] }]))).toBe(
      "BAD_USER_INPUT",
    );
    const many = Array.from({ length: 101 }, (_, i) => ({
      key: `o${i}`,
      label,
    }));
    expect(code(() => cleanOptions(many))).toBe("BAD_USER_INPUT");
    expect(cleanOptions(many.slice(0, 100))).toHaveLength(100);
  });

  test("removedOptionKeys lists what the new list no longer holds", () => {
    const before = [
      { key: "a", label },
      { key: "b", label },
    ];
    expect(removedOptionKeys(before, [{ key: "b", label }])).toEqual(["a"]);
    expect(removedOptionKeys(before, before)).toEqual([]);
  });
});

describe("behaviour", () => {
  test("the allowed combinations pass", () => {
    expect(() => checkBehaviour(base)).not.toThrow();
    expect(() => checkBehaviour({ ...base, unique: true })).not.toThrow();
    expect(() =>
      checkBehaviour({ ...base, type: "NUMBER", unique: true }),
    ).not.toThrow();
    expect(() =>
      checkBehaviour({ ...base, emission: { scope: "profile" } }),
    ).not.toThrow();
    expect(() =>
      checkBehaviour({
        ...base,
        type: "SELECT",
        options: [{ key: "a", label }],
      }),
    ).not.toThrow();
  });

  test("each refusal has its code", () => {
    expect(
      code(() => checkBehaviour({ ...base, type: "DATE", unique: true })),
    ).toBe("ATTRIBUTE_UNIQUE_UNSUPPORTED");
    expect(
      code(() =>
        checkBehaviour({
          ...base,
          emission: { scope: "x" },
          userEditable: true,
        }),
      ),
    ).toBe("ATTRIBUTE_EDITABLE_EMITTED");
    expect(
      code(() => checkBehaviour({ ...base, family: "ROLE", required: true })),
    ).toBe("BAD_USER_INPUT");
    expect(
      code(() => checkBehaviour({ ...base, options: [{ key: "a", label }] })),
    ).toBe("BAD_USER_INPUT");
  });
});
