import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { instance } from "~/narrow";
import { RolesError } from "./roles.errors";
import {
  checkPermissions,
  checkUserId,
  cleanDescription,
  cleanName,
  MAX_ID,
  MAX_PERMISSIONS,
  permissionObjectIds,
} from "./roles.rules";

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return instance(error, RolesError);
  }
  return undefined;
};

describe("cleanName", () => {
  test("trims a valid name", () => {
    expect(cleanName("  admin:read.v1_x-y ")).toBe("admin:read.v1_x-y");
  });

  test("refuses blank, spaced, accented and over-long names", () => {
    for (const bad of ["", "   ", "a b", "é", "a".repeat(65)]) {
      expect(refusal(() => cleanName(bad))?.code).toBe("BAD_USER_INPUT");
    }
    expect(cleanName("a".repeat(64))).toHaveLength(64);
  });
});

describe("cleanDescription", () => {
  test("is empty when absent and trimmed otherwise", () => {
    expect(cleanDescription(undefined)).toBe("");
    expect(cleanDescription("  hi ")).toBe("hi");
  });

  test("holds at most 300 characters", () => {
    expect(cleanDescription("x".repeat(300))).toHaveLength(300);
    expect(refusal(() => cleanDescription("x".repeat(301)))?.code).toBe(
      "BAD_USER_INPUT",
    );
  });
});

describe("checkUserId", () => {
  test("accepts 1 to 200 characters and refuses the rest", () => {
    expect(() => checkUserId("u")).not.toThrow();
    expect(() => checkUserId("u".repeat(MAX_ID))).not.toThrow();
    expect(refusal(() => checkUserId(""))?.code).toBe("BAD_USER_INPUT");
    expect(refusal(() => checkUserId("u".repeat(MAX_ID + 1)))?.code).toBe(
      "BAD_USER_INPUT",
    );
  });
});

describe("permissionObjectIds", () => {
  test("keeps the first of a repeated id and refuses a malformed one at its index", () => {
    const a = new ObjectId();
    const b = new ObjectId();
    const ids = permissionObjectIds([
      a.toHexString(),
      b.toHexString(),
      a.toHexString(),
    ]);
    expect(ids.map((i) => i.toHexString())).toEqual([
      a.toHexString(),
      b.toHexString(),
    ]);
    const bad = refusal(() => permissionObjectIds([a.toHexString(), "nope"]));
    expect(bad?.code).toBe("BAD_USER_INPUT");
    expect(bad?.field).toBe("permissionIds.1");
  });
});

describe("checkPermissions", () => {
  const resource = new ObjectId();
  const other = new ObjectId();
  const own = { _id: new ObjectId(), resourceId: resource };
  const foreign = { _id: new ObjectId(), resourceId: other };
  const standard = { _id: new ObjectId(), resourceId: null };
  const ids = (...scopes: { _id: ObjectId }[]) =>
    scopes.map((s) => s._id.toHexString());
  const all = [own, foreign, standard];

  test("a tenant-wide role may hold the scopes of any resource", () => {
    expect(() => checkPermissions(ids(own, foreign), null, all)).not.toThrow();
  });

  test("a role scoped to a resource holds only its scopes, at the breaching index", () => {
    expect(() => checkPermissions(ids(own), resource, all)).not.toThrow();
    const bad = refusal(() =>
      checkPermissions(ids(own, foreign), resource, all),
    );
    expect(bad?.code).toBe("BAD_USER_INPUT");
    expect(bad?.field).toBe("permissionIds.1");
  });

  test("a standard scope and an unknown scope are refused", () => {
    expect(
      refusal(() => checkPermissions(ids(standard), null, all))?.field,
    ).toBe("permissionIds.0");
    expect(
      refusal(() => checkPermissions([new ObjectId().toHexString()], null, all))
        ?.field,
    ).toBe("permissionIds.0");
  });

  test("holds at most MAX_PERMISSIONS ids", () => {
    const many = Array.from({ length: MAX_PERMISSIONS + 1 }, () =>
      new ObjectId().toHexString(),
    );
    expect(refusal(() => checkPermissions(many, null, []))?.field).toBe(
      "permissionIds",
    );
  });
});
