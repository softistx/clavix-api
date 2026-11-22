import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { AttributeDoc } from "../attributes.types";
import {
  byPosition,
  fieldsOf,
  idsOf,
  MIN_GAP,
  positionAfter,
  positionAt,
  STEP,
  shape,
  target,
} from "./attributes.utils";

const stored = (key: string, position: number): AttributeDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId: new ObjectId(),
    key,
    family: "USER",
    type: "STRING",
    label: [{ locale: "en", text: key }],
    description: [],
    unit: null,
    options: [],
    required: false,
    userEditable: false,
    unique: false,
    emission: null,
    position,
    archivedAt: null,
    version: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
};

describe("positions", () => {
  test("byPosition sorts by position then key, without touching the input", () => {
    const input = [stored("b", 2), stored("c", 1), stored("a", 2)];
    expect(byPosition(input).map((a) => a.key)).toEqual(["c", "a", "b"]);
    expect(input.map((a) => a.key)).toEqual(["b", "c", "a"]);
  });

  test("positionAfter goes one step past the last", () => {
    expect(positionAfter([])).toBe(STEP);
    expect(positionAfter([stored("a", 5), stored("b", 2500)])).toBe(
      2500 + STEP,
    );
  });

  test("positionAt splits the gap and clamps the index", () => {
    const others = [stored("a", 1000), stored("b", 2000)];
    expect(positionAt([], 0)).toBe(STEP);
    expect(positionAt(others, 0)).toBe(1000 - STEP);
    expect(positionAt(others, 1)).toBe(1500);
    expect(positionAt(others, 2)).toBe(2000 + STEP);
    expect(positionAt(others, 99)).toBe(2000 + STEP);
    expect(positionAt(others, -4)).toBe(1000 - STEP);
  });

  test("positionAt answers null when the neighbours are too close", () => {
    const close = [stored("a", 1), stored("b", 1 + MIN_GAP / 2)];
    expect(positionAt(close, 1)).toBeNull();
  });
});

describe("views", () => {
  test("shape shows the attribute with its count and the role seam", () => {
    const attribute = stored("size", 1000);
    expect(shape(attribute, 4)).toEqual({
      id: attribute._id.toHexString(),
      key: "size",
      family: "USER",
      type: "STRING",
      label: attribute.label,
      description: [],
      unit: null,
      options: [],
      required: false,
      userEditable: false,
      unique: false,
      emissionScope: null,
      archivedAt: null,
      valueCount: 4,
      roles: [],
      version: 3,
    });
    expect(
      shape({ ...attribute, emission: { scope: "profile" } }, 0).emissionScope,
    ).toBe("profile");
  });

  test("target names the attribute and its tenant; idsOf and fieldsOf read the document", () => {
    expect(target("a", "t")).toEqual({
      type: "userAttribute",
      id: "a",
      tenantId: "t",
    });
    const attribute = stored("x", 1);
    expect(idsOf([attribute])).toEqual([attribute._id]);
    expect(Object.keys(fieldsOf(attribute)).sort()).toEqual([
      "description",
      "emission",
      "label",
      "options",
      "required",
      "type",
      "unique",
      "unit",
      "userEditable",
    ]);
  });
});
