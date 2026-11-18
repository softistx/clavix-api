import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

/** The attributes of D24 a tenant puts on every span and log of its requests. Never a name, e-mail or address. */
export const tenantAttributes = (
  tenant: Pick<ResolvedTenant, "tenantId" | "plan">,
) => ({
  "clavix.tenant.id": tenant.tenantId,
  "clavix.tenant.plan": tenant.plan,
});

/** Paths that name no tenant: probes and the internal endpoints, so they never read the tenants. */
export const isTenantless = (pathname: string) =>
  pathname === "/healthz" ||
  pathname === "/readyz" ||
  pathname.startsWith("/internal/");
