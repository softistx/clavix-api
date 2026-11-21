import { origin, tenantResolver } from "@/config/tenancy";
import type { Tenant } from "@/modules/tenants";
import { hostOf, issuerOf } from "@/modules/tenants";

/** The issuer the runtime uses for a tenant: the primary custom domain when there is one. */
export async function issuerFor(tenant: Pick<Tenant, "slug">) {
  const resolved = await tenantResolver.resolveHost(
    hostOf(tenant.slug, origin.domain),
  );
  return resolved?.issuer ?? issuerOf(tenant.slug, origin);
}
