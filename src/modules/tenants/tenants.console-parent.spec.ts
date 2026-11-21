import { describe, expect, it } from "bun:test";
import { tenantDoc } from "~/tenant-doc";
import { parentOf } from "./tenants.console-parent";

describe("tenants console parent", () => {
  it("carries the id, slug, name and the stored document", () => {
    const tenant = tenantDoc();
    const { _id } = tenant;
    expect(parentOf(tenant)).toEqual({
      id: _id.toHexString(),
      slug: "acme",
      name: "Acme",
      doc: tenant,
    });
  });
});
