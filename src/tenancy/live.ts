import { fail } from "@/shared/errors";
import {
  isLive,
  type ResolvedTenant,
  TENANT_SUSPENDED,
} from "./resolved-tenant";

/** The refusal of a sign-in or a token on a suspended or deleted tenant (ADR-0039). */
export const tenantSuspended = () =>
  fail(TENANT_SUSPENDED, "This service is suspended", { status: 403 });

/** Passes a live tenant, throws `TENANT_SUSPENDED` for a suspended or deleted one. */
export function requireLive(tenant: Pick<ResolvedTenant, "status">): void {
  if (!isLive(tenant)) throw tenantSuspended();
}
