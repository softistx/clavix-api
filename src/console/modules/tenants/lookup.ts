import { denial } from "@softistx/janus-graphql";
import { NotFoundError } from "@softistx/mongo";
import { tenantAdmin } from "@/config/tenancy";
import type { Tenant } from "@/modules/tenants/tenants.model";
import { refusal } from "./errors";
import type { TenantParent } from "./parent";

export const notFound = () => denial("NOT_FOUND", "No such tenant");

// The stored tenant of a parent: the one it carries, else read once.
export async function docOf(parent: TenantParent): Promise<Tenant> {
  parent.doc ??= await tenantAdmin.get(parent.id).catch((error: unknown) => {
    throw error instanceof NotFoundError ? notFound() : error;
  });
  return parent.doc;
}

// A tenant the caller may write to: it exists and is not in the trash.
export async function writable(id: string): Promise<Tenant> {
  const tenant = await tenantAdmin.find(id.toLowerCase());
  if (tenant === undefined || tenant.deletedAt !== null) throw notFound();
  return tenant;
}

// The service's `NotFoundError` as the contract's NOT_FOUND.
export const asNotFound = (error: unknown) =>
  error instanceof NotFoundError ? notFound() : refusal(error);
