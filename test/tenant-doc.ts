import { ObjectId } from "mongodb";
import type { Tenant } from "@/modules/tenants/tenants.model";
import { tenants } from "@/modules/tenants/tenants.model";

/**
 * A complete stored tenant, built by the collection's own schema (so every
 * default is the real one) with the stamps a read adds. `over` replaces fields.
 */
export function tenantDoc(over: Partial<Tenant> = {}): Tenant {
  const _id = new ObjectId();
  const now = new Date(0);
  return {
    ...tenants.schema.parse({
      _id,
      slug: "acme",
      name: "Acme",
      createdAt: now,
      updatedAt: now,
      version: 0,
    }),
    id: _id.toHexString(),
    ...over,
  };
}
