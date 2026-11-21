import { fail } from "@/shared/errors";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { isEnabled, type MethodType } from "./sign-in.schema";

/** A method the tenant did not turn on does not exist: 404, before any budget, store or mail is touched. */
export const methodDisabled = (method: string) =>
  fail("SIGN_IN_METHOD_DISABLED", `Sign-in by ${method} is disabled`, {
    status: 404,
  });

/** Throws `SIGN_IN_METHOD_DISABLED` unless the tenant's policy offers `method` (magic link has janus's own gate, `MAGIC_LINK_DISABLED`). */
export function requireMethod(
  tenant: ResolvedTenant,
  method: Exclude<MethodType, "magicLink">,
): void {
  if (!isEnabled(tenant.signIn, method)) throw methodDisabled(method);
}
