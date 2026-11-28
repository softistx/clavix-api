import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { RoleDoc } from "@/modules/roles";
import type { AttributeDoc, RoleAttributeDoc } from "../attributes.types";
import {
  distinctAttributes,
  distinctIds,
  heldLinking,
  linksByAttribute,
  roleSections,
} from "./role-attributes.utils";

const tenantId = new ObjectId();

const role = (name: string): RoleDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId,
    name,
    description: "",
    resourceId: null,
    managed: false,
    permissionIds: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
};

const attribute = (
  key: string,
  position: number,
  extra: Partial<AttributeDoc> = {},
): AttributeDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId,
    key,
    family: "ROLE",
    type: "STRING",
    label: [],
    description: [],
    unit: null,
    options: [],
    required: false,
    userEditable: false,
    unique: false,
    emission: null,
    position,
    archivedAt: null,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
};

const link = (
  r: RoleDoc,
  a: AttributeDoc,
  required = false,
): RoleAttributeDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId,
    roleId: r._id,
    attributeId: a._id,
    required,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
};

describe("role attribute helpers", () => {
  test("linksByAttribute groups by attribute, sorts by role name, drops unknown roles", () => {
    const b = role("b");
    const a = role("a");
    const gone = role("gone");
    const x = attribute("x", 1);
    const grouped = linksByAttribute(
      [link(b, x, true), link(a, x), link(gone, x)],
      [b, a],
    );
    expect(grouped.get(x.id)?.map((l) => [l.role.name, l.required])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  test("roleSections keeps held roles with a live role attribute, by position, with the link's required", () => {
    const doctor = role("doctor");
    const nurse = role("nurse");
    const idle = role("idle");
    const late = attribute("late", 2000);
    const early = attribute("early", 1000);
    const old = attribute("old", 3000, { archivedAt: new Date(1) });
    const general = attribute("general", 4000, { family: "USER" });
    const lone = attribute("lone", 5000, { archivedAt: new Date(1) });
    const found = new Map(
      [late, early, old, general, lone].map((a) => [a.id, a]),
    );
    const sections = roleSections(
      [nurse, doctor, idle],
      [
        link(doctor, late, true),
        link(doctor, early),
        link(doctor, old),
        link(doctor, general),
        link(nurse, lone),
      ],
      found,
    );
    expect(sections.map((s) => s.role.name)).toEqual(["doctor"]);
    expect(
      sections[0]?.items.map((i) => [i.attribute.key, i.required]),
    ).toEqual([
      ["early", false],
      ["late", true],
    ]);
  });

  test("heldLinking lists the held roles that link each attribute, by name", () => {
    const b = role("b");
    const a = role("a");
    const other = role("other");
    const x = attribute("x", 1);
    const y = attribute("y", 2);
    const grouped = heldLinking(
      [b, a],
      [link(b, x), link(a, x), link(other, y)],
    );
    expect(grouped.get(x.id)?.map((r) => r.name)).toEqual(["a", "b"]);
    expect(grouped.has(y.id)).toBe(false);
  });

  test("distinctIds and distinctAttributes drop repeats and keep the first order", () => {
    const one = new ObjectId();
    const two = new ObjectId();
    expect(distinctIds([one, two, new ObjectId(one.toHexString())])).toEqual([
      one,
      two,
    ]);
    const a = attribute("a", 1);
    const b = attribute("b", 2);
    expect(distinctAttributes([b, a, b]).map((x) => x.key)).toEqual(["b", "a"]);
  });
});
