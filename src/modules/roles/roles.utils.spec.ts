import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { RoleDoc } from "./roles.types";
import {
  claimNames,
  countsByRole,
  heldRoles,
  sortedByName,
} from "./roles.utils";

const role = (name: string, resourceId: ObjectId | null = null) =>
  ({ _id: new ObjectId(), name, resourceId }) as unknown as RoleDoc;

describe("sortedByName", () => {
  test("sorts a copy by name", () => {
    const input = [role("b"), role("a")];
    expect(sortedByName(input).map((r) => r.name)).toEqual(["a", "b"]);
    expect(input.map((r) => r.name)).toEqual(["b", "a"]);
  });
});

describe("heldRoles", () => {
  test("keeps the roles of the ids, sorted", () => {
    const [b, a, c] = [role("b"), role("a"), role("c")] as [
      RoleDoc,
      RoleDoc,
      RoleDoc,
    ];
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
    const [a, b] = [role("a"), role("b")] as [RoleDoc, RoleDoc];
    const counts = countsByRole([a, b], [{ _id: a._id, n: 3 }]);
    expect(counts.get(a._id.toHexString())).toBe(3);
    expect(counts.get(b._id.toHexString())).toBe(0);
  });
});
