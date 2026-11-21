import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { RoleDoc } from "./roles.types";
import {
  claimNames,
  countsByRole,
  heldRoles,
  shape,
  sortedByName,
  target,
} from "./roles.utils";

const stored = (over: Partial<RoleDoc>): RoleDoc => {
  const _id = new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId: new ObjectId(),
    name: "admin",
    description: "",
    resourceId: null,
    managed: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
};

const role = (name: string, resourceId: ObjectId | null = null) =>
  stored({ name, resourceId });

describe("sortedByName", () => {
  test("sorts a copy by name", () => {
    const input = [role("b"), role("a")];
    expect(sortedByName(input).map((r) => r.name)).toEqual(["a", "b"]);
    expect(input.map((r) => r.name)).toEqual(["b", "a"]);
  });
});

describe("heldRoles", () => {
  test("keeps the roles of the ids, sorted", () => {
    const b = role("b");
    const a = role("a");
    const c = role("c");
    const ids = new Set([b._id.toHexString(), a._id.toHexString()]);
    expect(heldRoles([b, a, c], ids).map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("claimNames", () => {
  const resource = new ObjectId();
  const held = [
    role("tenant"),
    role("scoped", resource),
    role("other", new ObjectId()),
    role("tenant"),
  ];

  test("gives the tenant-wide roles when no resource matches", () => {
    expect(claimNames(held, null)).toEqual(["tenant"]);
  });

  test("adds the roles of the audience's resource, once per name", () => {
    expect(claimNames(held, resource.toHexString())).toEqual([
      "scoped",
      "tenant",
    ]);
  });
});

describe("countsByRole", () => {
  test("a role nobody holds counts 0", () => {
    const a = role("a");
    const b = role("b");
    const counts = countsByRole([a, b], [{ _id: a._id, n: 3 }]);
    expect(counts.get(a._id.toHexString())).toBe(3);
    expect(counts.get(b._id.toHexString())).toBe(0);
  });
});

describe("shape", () => {
  test("an empty description is null, a tenant-wide role has no resource", () => {
    const shown = shape(stored({}), 3);
    expect(shown.description).toBeNull();
    expect(shown.resourceId).toBeNull();
    expect(shown.memberCount).toBe(3);
  });

  test("ids come out as hex", () => {
    const resourceId = new ObjectId();
    const found = stored({ description: "d", resourceId });
    const shown = shape(found, 0);
    expect(shown.id).toBe(found._id.toHexString());
    expect(shown.resourceId).toBe(resourceId.toHexString());
    expect(shown.description).toBe("d");
  });
});

describe("target", () => {
  test("names the type, the id and the tenant", () => {
    expect(target("user", "u1", "t1")).toEqual({
      type: "user",
      id: "u1",
      tenantId: "t1",
    });
  });
});
