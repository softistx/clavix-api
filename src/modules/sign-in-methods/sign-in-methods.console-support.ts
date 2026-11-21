import { issuerFor } from "@/console/modules/issuer";
import type { Tenant } from "@/modules/tenants";
import { policyShape } from "./sign-in-methods.utils";

/** The policy as the console shows it, with the redirect URIs of the issuer the runtime uses. */
export async function policyOf(tenant: Tenant) {
  return policyShape(tenant, await issuerFor(tenant));
}
