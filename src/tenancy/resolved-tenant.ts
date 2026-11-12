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
  issuer: z.string(),
  partition: z.string(),
  version: z.number(),
});

export type ResolvedTenant = z.infer<typeof resolvedTenant>;
