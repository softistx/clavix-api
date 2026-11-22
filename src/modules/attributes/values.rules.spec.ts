import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { extensionCodeOf } from "@/shared/errors";
import type { AttributeType } from "./attributes.model";
import type { AttributeDoc } from "./attributes.types";
import {
  canonicalValue,
  fieldOf,
  isEmpty,
  MAX_SELECTED,
  MAX_STRING,
  MAX_TEXT,
  uniqueKeyOf,
} from "./values.rules";

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return `${extensionCodeOf(error)}`;
  }
  return undefined;
};

const attribute = (type: AttributeType, keys: string[] = []): AttributeDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId: new ObjectId(),
    key: "k",
    family: "USER",
    type,
    label: [],
    description: [],
    unit: null,
    options: keys.map((key) => ({ key, label: [] })),
    required: false,
    userEditable: false,
    unique: false,
    emission: null,
    position: 1000,
    archivedAt: null,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
};

const INVALID = "ATTRIBUTE_VALUE_INVALID";

describe("canonicalValue", () => {
  test("text types trim, normalise and cap", () => {
    expect(canonicalValue(attribute("STRING"), { text: "  Ada " }, 0)).toBe(
      "Ada",
    );
    expect(canonicalValue(attribute("STRING"), { text: "é" }, 0)).toBe("é");
    expect(
      code(() => canonicalValue(attribute("STRING"), { text: "  " }, 0)),
    ).toBe(INVALID);
    expect(
      code(() =>
        canonicalValue(
          attribute("STRING"),
          { text: "x".repeat(MAX_STRING + 1) },
          3,
        ),
      ),
    ).toBe(INVALID);
    expect(
      canonicalValue(attribute("TEXT"), { text: "x".repeat(MAX_TEXT) }, 0),
    ).toHaveLength(MAX_TEXT);
    expect(
      code(() =>
        canonicalValue(
          attribute("TEXT"),
          { text: "x".repeat(MAX_TEXT + 1) },
          0,
        ),
      ),
    ).toBe(INVALID);
  });

  test("the field must be the type's, and the only one", () => {
    expect(fieldOf("DATETIME")).toBe("dateTime");
    expect(
      code(() => canonicalValue(attribute("NUMBER"), { text: "1" }, 0)),
    ).toBe(INVALID);
    expect(
      code(() =>
        canonicalValue(attribute("NUMBER"), { number: 1, text: "1" }, 0),
      ),
    ).toBe(INVALID);
    expect(code(() => canonicalValue(attribute("NUMBER"), {}, 0))).toBe(
      INVALID,
    );
  });

  test("the field of the refusal is values.<index>", () => {
    try {
      canonicalValue(attribute("NUMBER"), { number: Number.NaN }, 4);
    } catch (error) {
      expect(JSON.stringify(error)).toContain("values.4");
    }
  });

  test("number: finite, minus zero is zero", () => {
    expect(canonicalValue(attribute("NUMBER"), { number: 4.5 }, 0)).toBe(4.5);
    expect(canonicalValue(attribute("NUMBER"), { number: -0 }, 0)).toBe(0);
    expect(
      code(() => canonicalValue(attribute("NUMBER"), { number: Infinity }, 0)),
    ).toBe(INVALID);
  });

  test("boolean keeps false", () => {
    expect(canonicalValue(attribute("BOOLEAN"), { boolean: false }, 0)).toBe(
      false,
    );
    expect(canonicalValue(attribute("BOOLEAN"), { boolean: true }, 0)).toBe(
      true,
    );
  });

  test("color: a hex code, lower-cased", () => {
    expect(canonicalValue(attribute("COLOR"), { color: "#AABBCC" }, 0)).toBe(
      "#aabbcc",
    );
    expect(
      code(() => canonicalValue(attribute("COLOR"), { color: "red" }, 0)),
    ).toBe(INVALID);
  });

  test("date: a real calendar day at UTC midnight", () => {
    const day = canonicalValue(attribute("DATE"), { date: "2026-02-28" }, 0);
    expect(day).toEqual(new Date("2026-02-28T00:00:00.000Z"));
    for (const bad of ["2026-02-30", "2026-2-3", "x", "2026-13-01"])
      expect(
        code(() => canonicalValue(attribute("DATE"), { date: bad }, 0)),
      ).toBe(INVALID);
  });

  test("dateTime: a valid moment", () => {
    const at = new Date("2026-05-06T07:08:09.000Z");
    expect(canonicalValue(attribute("DATETIME"), { dateTime: at }, 0)).toEqual(
      at,
    );
    expect(
      code(() =>
        canonicalValue(attribute("DATETIME"), { dateTime: "nope" }, 0),
      ),
    ).toBe(INVALID);
  });

  test("time: HH:mm or HH:mm:ss, stored with seconds", () => {
    expect(canonicalValue(attribute("TIME"), { time: "09:30" }, 0)).toBe(
      "09:30:00",
    );
    expect(canonicalValue(attribute("TIME"), { time: "23:59:58" }, 0)).toBe(
      "23:59:58",
    );
    for (const bad of ["24:00", "9:30", "12:61", ""])
      expect(
        code(() => canonicalValue(attribute("TIME"), { time: bad }, 0)),
      ).toBe(INVALID);
  });

  test("select: exactly one known option", () => {
    const select = attribute("SELECT", ["a", "b"]);
    expect(canonicalValue(select, { options: ["b"] }, 0)).toEqual(["b"]);
    for (const bad of [[], ["a", "b"], ["c"]])
      expect(code(() => canonicalValue(select, { options: bad }, 0))).toBe(
        INVALID,
      );
  });

  test("multi select: known, distinct, at least one, at most the cap", () => {
    const keys = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => `k${i}`);
    const multi = attribute("MULTI_SELECT", keys);
    expect(canonicalValue(multi, { options: ["k1", "k2"] }, 0)).toEqual([
      "k1",
      "k2",
    ]);
    expect(code(() => canonicalValue(multi, { options: [] }, 0))).toBe(INVALID);
    expect(
      code(() => canonicalValue(multi, { options: ["k1", "k1"] }, 0)),
    ).toBe(INVALID);
    expect(code(() => canonicalValue(multi, { options: ["zz"] }, 0))).toBe(
      INVALID,
    );
    expect(code(() => canonicalValue(multi, { options: keys }, 0))).toBe(
      INVALID,
    );
  });
});

describe("uniqueKeyOf and isEmpty", () => {
  test("the key of a STRING is trimmed and lower-cased, of a NUMBER canonical", () => {
    expect(uniqueKeyOf("STRING", "  AdA ")).toBe("ada");
    expect(uniqueKeyOf("NUMBER", 1.5)).toBe("1.5");
    expect(uniqueKeyOf("NUMBER", 1e21)).toBe("1e+21");
    expect(uniqueKeyOf("BOOLEAN", true)).toBeNull();
    expect(uniqueKeyOf("STRING", 3)).toBeNull();
  });

  test("empty is no value, a blank string or an empty list", () => {
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty("")).toBe(true);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(false)).toBe(false);
    expect(isEmpty(0)).toBe(false);
  });
});
