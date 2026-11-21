import { describe, expect, test } from "bun:test";
import { detailTypeDoc, scopeDoc } from "~/resource-docs";

describe("scopeDoc", () => {
  test("is a complete scope, its id the hex of its _id", () => {
    const scope = scopeDoc();
    expect(scope).toMatchObject({ name: "read", resourceId: null, claims: [] });
    expect(scope.id).toBe(scope._id.toHexString());
    expect(scope.createdAt.getTime()).toBe(0);
  });

  test("lays the fields of the spec over it", () => {
    expect(scopeDoc({ name: "write" }).name).toBe("write");
    expect(scopeDoc().id).not.toBe(scopeDoc().id);
  });
});

describe("detailTypeDoc", () => {
  test("is a complete detail type with one integer field", () => {
    const detail = detailTypeDoc();
    expect(detail.type).toBe("pay");
    expect(detail.fields).toHaveLength(1);
    expect(detail.fields[0]).toMatchObject({ key: "n", kind: "integer" });
    expect(detail.id).toBe(detail._id.toHexString());
  });

  test("lays the fields of the spec over it", () => {
    expect(detailTypeDoc({ type: "refund" }).type).toBe("refund");
  });
});
