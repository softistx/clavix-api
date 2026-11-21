import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { methodDisabled } from "./sign-in-methods.errors";
import { isEnabled, type MethodType } from "./sign-in-methods.schema";

/** Throws `SIGN_IN_METHOD_DISABLED` unless the tenant's policy offers `method` (magic link has janus's own gate, `MAGIC_LINK_DISABLED`). */
export function requireMethod(
  tenant: ResolvedTenant,
  method: Exclude<MethodType, "magicLink">,
): void {
  if (!isEnabled(tenant.signIn, method)) throw methodDisabled(method);
}
