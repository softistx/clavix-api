import { GraphQLError } from "graphql";
import {
  isLive,
  type ResolvedTenant,
  TENANT_SUSPENDED,
} from "./resolved-tenant";

/** The refusal of a sign-in or a token on a suspended or deleted tenant (ADR-0039). */
export const tenantSuspended = () =>
  new GraphQLError("This service is suspended", {
    extensions: { code: TENANT_SUSPENDED, http: { status: 403 } },
  });

/** Passes a live tenant, throws `TENANT_SUSPENDED` for a suspended or deleted one. */
export function requireLive(tenant: Pick<ResolvedTenant, "status">): void {
  if (!isLive(tenant)) throw tenantSuspended();
}
