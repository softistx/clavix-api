import { describe, expect, it } from "bun:test";
import { ObjectId } from "mongodb";
import { parentOf } from "./tenants.console-parent";
import type { Tenant } from "./tenants.model";

describe("tenants console parent", () => {
  it("carries the id, slug, name and the stored document", () => {
    const _id = new ObjectId();
    const tenant = { _id, slug: "acme", name: "Acme" } as unknown as Tenant;
    expect(parentOf(tenant)).toEqual({
      id: _id.toHexString(),
      slug: "acme",
      name: "Acme",
      doc: tenant,
    });
  });
});
