import type { Tenant } from "@/modules/tenants";

/**
 * What a `Tenant` resolver starts from: the console names a tenant by id, slug
 * and name (`Me.memberships` has no more), and carries the stored document
 * when the query already read it; the other fields load it on demand.
 */
export interface TenantParent {
  id: string;
  slug: string;
  name: string;
  doc?: Tenant;
}

export const parentOf = (tenant: Tenant): TenantParent => ({
  id: tenant._id.toHexString(),
  slug: tenant.slug,
  name: tenant.name,
  doc: tenant,
});
