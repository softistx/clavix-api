import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { AttributeType } from "../attributes.model";
import type { AttributeDoc } from "../attributes.types";
import type { ValueDoc } from "../values.types";
import {
  byUser,
  isRequired,
  matches,
  ownAttributeView,
  sectionValueView,
  shown,
} from "./values.utils";

const attribute = (type: AttributeType): AttributeDoc => {
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
    options: [],
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

const stored = (
  a: AttributeDoc,
  value: ValueDoc["value"],
  userId = "u1",
): ValueDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId: a.tenantId,
    userId,
    attributeId: a._id,
    type: a.type,
    value,
    uniqueKey: null,
    updatedBy: { kind: "admin", id: "a1" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
};

describe("shown", () => {
  test("the typed field holds the value, the others are null", () => {
    const day = attribute("DATE");
    expect(
      shown(day, stored(day, new Date("2026-03-04T00:00:00.000Z"))),
    ).toMatchObject({
      date: "2026-03-04",
      text: null,
      dateTime: null,
    });
    const multi = attribute("MULTI_SELECT");
    expect(shown(multi, stored(multi, ["a", "b"])).options).toEqual(["a", "b"]);
    const flag = attribute("BOOLEAN");
    expect(shown(flag, stored(flag, false)).boolean).toBe(false);
    const n = attribute("NUMBER");
    expect(shown(n, stored(n, 3)).number).toBe(3);
    const text = attribute("TEXT");
    expect(shown(text, stored(text, "hi")).text).toBe("hi");
  });

  test("no value, or one written under another type, shows empty", () => {
    const n = attribute("NUMBER");
    const empty = shown(n, undefined);
    expect(empty.attributeId).toBe(n._id.toHexString());
    expect(
      Object.values({ ...empty, attributeId: null }).every((v) => v === null),
    ).toBe(true);
    const old = stored(n, 3);
    const changed = { ...n, type: "STRING" as const };
    expect(matches(old, changed)).toBe(false);
    expect(shown(changed, old).text).toBeNull();
  });
});

describe("byUser", () => {
  test("groups the values by user id", () => {
    const a = attribute("STRING");
    const grouped = byUser([
      stored(a, "x", "u1"),
      stored(a, "y", "u2"),
      stored(a, "z", "u1"),
    ]);
    expect(grouped.get("u1")?.map((v) => v.value)).toEqual(["x", "z"]);
    expect(grouped.get("u2")?.length).toBe(1);
  });
});

describe("role sections", () => {
  test("isRequired reads the attribute's flag in the general section and the link's in a role's", () => {
    const a = { ...attribute("STRING"), required: true };
    expect(isRequired(a, { family: "USER" })).toBe(true);
    expect(isRequired(a, { family: "ROLE", links: new Map() })).toBe(false);
    expect(
      isRequired(a, { family: "ROLE", links: new Map([[a.id, true]]) }),
    ).toBe(true);
    expect(
      isRequired(a, { family: "ROLE", links: new Map([[a.id, false]]) }),
    ).toBe(false);
  });

  test("sectionValueView gives the link's required and the user's own value", () => {
    const a = { ...attribute("STRING"), family: "ROLE" as const };
    const held = [stored(a, "x"), stored(attribute("STRING"), "y")];
    expect(sectionValueView(a, true, 3, held, []).attribute.required).toBe(
      true,
    );
    expect(sectionValueView(a, true, 3, held, []).text).toBe("x");
    expect(sectionValueView(a, false, 3, undefined, []).text).toBeNull();
  });
});

describe("ownAttributeView", () => {
  test("names the attribute and puts the value in the field of its type", () => {
    const a = { ...attribute("STRING"), required: true };
    const view = ownAttributeView(a, stored(a, "hello"));
    expect(view.attribute).toMatchObject({
      id: a._id.toHexString(),
      key: "k",
      type: "STRING",
      required: true,
    });
    expect(view.text).toBe("hello");
    expect(view.options).toBeNull();
  });

  test("shows an attribute with no value empty", () => {
    const view = ownAttributeView(attribute("NUMBER"), undefined);
    expect(view.number).toBeNull();
  });
});
