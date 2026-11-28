import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { RoleDoc } from "@/modules/roles";
import type { AttributeType } from "../attributes.model";
import type { AttributeDoc } from "../attributes.types";
import type { ValueDoc } from "../values.types";
import { claimsOf, claimTable, claimValue, roleApplies } from "./claims.utils";

const attribute = (
  type: AttributeType,
  key = "k",
  family: AttributeDoc["family"] = "USER",
): AttributeDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId: new ObjectId(),
    key,
    family,
    type,
    label: [],
    description: [],
    unit: null,
    options: [],
    required: false,
    userEditable: false,
    unique: false,
    emission: { scope: "read" },
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
  type: AttributeType = a.type,
): ValueDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId: a.tenantId,
    userId: "u1",
    attributeId: a._id,
    type,
    value,
    uniqueKey: null,
    updatedBy: { kind: "admin", id: "a1" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
};

const role = (resourceId: ObjectId | null): RoleDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId: new ObjectId(),
    name: "r",
    description: "",
    resourceId,
    managed: false,
    permissionIds: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
};

describe("claimValue", () => {
  test("encodes each type the way the plan says", () => {
    expect(claimValue(attribute("STRING"), "x")).toBe("x");
    expect(claimValue(attribute("TEXT"), "long")).toBe("long");
    expect(claimValue(attribute("COLOR"), "#ff0000")).toBe("#ff0000");
    expect(claimValue(attribute("TIME"), "09:30")).toBe("09:30");
    expect(claimValue(attribute("NUMBER"), 4.5)).toBe(4.5);
    expect(claimValue(attribute("BOOLEAN"), false)).toBe(false);
    expect(
      claimValue(attribute("DATE"), new Date("2026-03-04T00:00:00.000Z")),
    ).toBe("2026-03-04");
    expect(
      claimValue(attribute("DATETIME"), new Date("2026-03-04T10:20:30.000Z")),
    ).toBe("2026-03-04T10:20:30.000Z");
    expect(claimValue(attribute("SELECT"), ["red"])).toBe("red");
    expect(claimValue(attribute("MULTI_SELECT"), ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  test("a value that does not fit its type is not a claim", () => {
    expect(claimValue(attribute("NUMBER"), "4")).toBeUndefined();
    expect(claimValue(attribute("BOOLEAN"), "true")).toBeUndefined();
    expect(claimValue(attribute("DATE"), "2026-03-04")).toBeUndefined();
    expect(claimValue(attribute("SELECT"), ["a", "b"])).toBeUndefined();
    expect(claimValue(attribute("STRING"), 3)).toBeUndefined();
  });
});

describe("roleApplies", () => {
  const resource = new ObjectId();
  test("a tenant-wide role applies to every audience", () => {
    expect(roleApplies([role(null)], null)).toBe(true);
    expect(roleApplies([role(null)], resource)).toBe(true);
  });

  test("a role of a resource applies to that audience only", () => {
    expect(roleApplies([role(resource)], resource)).toBe(true);
    expect(roleApplies([role(resource)], new ObjectId())).toBe(false);
    expect(roleApplies([role(resource)], null)).toBe(false);
    expect(roleApplies([], resource)).toBe(false);
  });
});

describe("claimsOf", () => {
  test("a user attribute needs a value of its current type", () => {
    const name = attribute("STRING", "nick");
    const age = attribute("NUMBER", "age");
    const claims = claimsOf(
      [name, age],
      [stored(name, "bob"), stored(age, 3, "STRING")],
      new Set(),
    );
    expect(claims).toEqual({ nick: "bob" });
  });

  test("a role attribute needs a held role that applies", () => {
    const badge = attribute("STRING", "badge", "ROLE");
    const values = [stored(badge, "B-7")];
    expect(claimsOf([badge], values, new Set())).toEqual({});
    expect(claimsOf([badge], values, new Set([badge.id]))).toEqual({
      badge: "B-7",
    });
  });

  test("an attribute with no value is left out", () => {
    expect(claimsOf([attribute("BOOLEAN", "flag")], [], new Set())).toEqual({});
  });
});

describe("claimTable", () => {
  const on = (key: string, scope: string | null): AttributeDoc => ({
    ...attribute("STRING", key),
    emission: scope === null ? null : { scope },
  });

  test("lists each emission scope with its claim keys, sorted", () => {
    expect(
      claimTable([on("b", "read"), on("a", "read"), on("c", "profile")]),
    ).toEqual({ read: ["a", "b"], profile: ["c"] });
  });

  test("an attribute with no emission scope is not listed", () => {
    expect(claimTable([on("quiet", null)])).toEqual({});
    expect(claimTable([])).toEqual({});
  });
});
