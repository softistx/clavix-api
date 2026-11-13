import { z } from "zod";

/**
 * What a host resolves to: plain data, so it can sit in Redis. `issuer` and
 * `version` are what janus keys and rebuilds its per-issuer cache by
 * (`createOAuthIssuers`): `issuer` is stable for a tenant, `version` rises on
 * every tenant write.
 */
export const resolvedTenant = z.object({
  tenantId: z.string(),
  slug: z.string(),
  name: z.string(),
  signUp: z.boolean(),
  // Where the tenant stands (ADR-0039). A suspended or deleted tenant still
  // resolves: its discovery, JWKS, introspection and revocation answer, and
  // what opens or extends a session refuses it (`isLive`). An entry cached
  // before the field existed was an active tenant.
  status: z.enum(["active", "suspended", "deleted"]).default("active"),
  // Where tokens say they come from: the slug host's issuer, or the primary
  // custom domain's once the tenant made one primary (ADR-0032).
  issuer: z.string(),
  // The slug host's issuer, whatever `issuer` is: the passkey rpId stays on it
  // (ADR-0036). An entry cached before custom domains had none: `issuer` was it.
  slugIssuer: z.string().optional(),
  partition: z.string(),
  version: z.number(),
});

export type ResolvedTenant = z.infer<typeof resolvedTenant>;

/** Whether the tenant may sign users in and issue tokens; else `TENANT_SUSPENDED`. */
export const isLive = (tenant: Pick<ResolvedTenant, "status">) =>
  tenant.status === "active";

/** The code of every refusal a suspended or deleted tenant gets. */
export const TENANT_SUSPENDED = "TENANT_SUSPENDED";
