import { env } from "@/config/env";
import { tenantResolver } from "@/config/tenancy";
import type { Tenant } from "@/modules/tenants";
import { hostOf, issuerOf } from "@/modules/tenants";
import { policyShape } from "./sign-in-methods.utils";

/** The issuer the runtime uses for a tenant: the primary custom domain when there is one. */
export async function issuerFor(tenant: Pick<Tenant, "slug">) {
  const resolved = await tenantResolver.resolveHost(
    hostOf(tenant.slug, env.CLAVIX_DOMAIN),
  );
  return (
    resolved?.issuer ??
    issuerOf(tenant.slug, {
      scheme: env.CLAVIX_PUBLIC_SCHEME,
      domain: env.CLAVIX_DOMAIN,
      port: env.CLAVIX_PUBLIC_PORT,
    })
  );
}

/** The policy as the console shows it, with the redirect URIs of the issuer the runtime uses. */
export async function policyOf(tenant: Tenant) {
  return policyShape(tenant, await issuerFor(tenant));
}
