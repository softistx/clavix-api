import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { AttributeDoc } from "../attributes.types";
import {
  afterOf,
  cursorOf,
  filterConditions,
  filterIssue,
  isFilterable,
  matchPipeline,
  roleCondition,
  valueCondition,
} from "./user-filter.utils";

const tenantId = new ObjectId();

const attribute = (extra: Partial<AttributeDoc>): AttributeDoc => ({
  _id: new ObjectId(),
  id: "x",
  tenantId,
  key: "k",
  family: "USER",
  type: "SELECT",
  label: [],
  description: [],
  unit: null,
  options: [
    { key: "a", label: [] },
    { key: "b", label: [] },
  ],
  required: false,
  userEditable: false,
  unique: false,
  emission: null,
  position: 1,
  archivedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  version: 1,
  ...extra,
});

describe("cursor", () => {
  test("round trips the user id and refuses a foreign cursor", () => {
    expect(afterOf(cursorOf("u1"))).toBe("u1");
    expect(afterOf("u1")).toBeNull();
    expect(afterOf("f1.")).toBeNull();
  });
});

describe("isFilterable", () => {
  test("only the choices and the boolean", () => {
    expect(isFilterable(attribute({ type: "SELECT" }))).toBe(true);
    expect(isFilterable(attribute({ type: "MULTI_SELECT" }))).toBe(true);
    expect(isFilterable(attribute({ type: "BOOLEAN" }))).toBe(true);
    expect(isFilterable(attribute({ type: "STRING" }))).toBe(false);
  });
});

describe("filterIssue", () => {
  const id = "x";
  test("accepts known options and a boolean", () => {
    expect(
      filterIssue(attribute({}), { attributeId: id, options: ["a"] }),
    ).toBeNull();
    expect(
      filterIssue(attribute({ type: "BOOLEAN", options: [] }), {
        attributeId: id,
        boolean: false,
      }),
    ).toBeNull();
  });

  test("refuses what cannot filter", () => {
    const filter = { attributeId: id, options: ["a"] };
    expect(filterIssue(undefined, filter)).toBe("No such attribute");
    expect(filterIssue(attribute({ archivedAt: new Date() }), filter)).toBe(
      "The attribute is archived",
    );
    expect(filterIssue(attribute({ type: "STRING" }), filter)).toContain(
      "Only a choice",
    );
    expect(
      filterIssue(attribute({}), { attributeId: id, options: ["z"] }),
    ).toContain("not one of");
    expect(
      filterIssue(attribute({}), { attributeId: id, options: [] }),
    ).toContain("with options");
    expect(
      filterIssue(attribute({}), { attributeId: id, boolean: true }),
    ).toContain("with options");
    expect(
      filterIssue(attribute({ type: "BOOLEAN" }), {
        attributeId: id,
        options: ["a"],
      }),
    ).toContain("with boolean");
  });
});

describe("conditions", () => {
  test("a user attribute is one value condition under its type", () => {
    const selected = attribute({});
    const [value, ...more] = filterConditions(
      tenantId,
      selected,
      { attributeId: "x", options: ["a"] },
      [],
    );
    expect(more).toEqual([]);
    expect(value).toEqual(valueCondition(tenantId, selected, ["a"]));
    expect(value?.match).toMatchObject({
      type: "SELECT",
      value: { $in: ["a"] },
    });
  });

  test("a role attribute also needs a held linked role", () => {
    const linked = new ObjectId();
    const conditions = filterConditions(
      tenantId,
      attribute({ family: "ROLE", type: "BOOLEAN", options: [] }),
      { attributeId: "x", boolean: true },
      [linked],
    );
    expect(conditions).toHaveLength(2);
    expect(conditions[0]?.match).toMatchObject({ value: true });
    expect(conditions[1]).toEqual({
      from: "roleAssignments",
      match: { tenantId, roleId: { $in: [linked] } },
    });
  });
});

describe("matchPipeline", () => {
  const role = roleCondition(tenantId, new ObjectId());
  const value = valueCondition(tenantId, attribute({}), ["a"]);

  test("tags and unions every condition and keeps the users with all tags", () => {
    const pipeline = matchPipeline([role, value], {
      ids: null,
      after: null,
      limit: 25,
    });
    expect(pipeline[0]).toEqual({ $match: { _id: null } });
    expect(pipeline[1]).toMatchObject({
      $unionWith: { coll: "roleAssignments" },
    });
    expect(pipeline[2]).toMatchObject({
      $unionWith: { coll: "attributeValues" },
    });
    expect(pipeline).toContainEqual({ $match: { tags: { $size: 2 } } });
    expect(JSON.stringify(pipeline)).toContain('"$limit":26');
  });

  test("narrows to some ids and pages after a user id", () => {
    const pipeline = matchPipeline([role], {
      ids: ["u1"],
      after: "u0",
      limit: 5,
    });
    expect(pipeline).toContainEqual({ $match: { _id: { $in: ["u1"] } } });
    expect(JSON.stringify(pipeline)).toContain('"$gt":"u0"');
  });
});
