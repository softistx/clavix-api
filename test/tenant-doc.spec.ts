import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { tenantDoc } from "~/tenant-doc";

describe("tenantDoc", () => {
  test("is a complete stored tenant, its id the hex of its _id", () => {
    const tenant = tenantDoc();
    expect(tenant).toMatchObject({ slug: "acme", name: "Acme", version: 0 });
    expect(tenant._id).toBeInstanceOf(ObjectId);
    expect(tenant.id).toBe(tenant._id.toHexString());
    expect(tenant.createdAt.getTime()).toBe(0);
  });

  test("lays the fields of the spec over it", () => {
    expect(tenantDoc({ slug: "beta", name: "Beta" })).toMatchObject({
      slug: "beta",
      name: "Beta",
    });
  });

  test("gives a new id each time", () => {
    expect(tenantDoc().id).not.toBe(tenantDoc().id);
  });
});
