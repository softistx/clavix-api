import { z } from "zod";
import { signInPolicySchema } from "@/modules/sign-in-methods/sign-in.schema";

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
  // (ADR-0036). Always set by the resolver; an entry cached before custom
  // domains has none, fails this schema and reads as a cache miss (60 s TTL).
  slugIssuer: z.string(),
  // Origins of the tenant's verified custom domains (ADR-0036): the passkey
  // layer accepts a ceremony from each. A domain write drops the slug host's
  // entry, so it follows verification and removal. An entry cached before the
  // field existed has none until it expires (60 s).
  relatedOrigins: z.array(z.string()).default([]),
  partition: z.string(),
  version: z.number(),
  signIn: signInPolicySchema, // slice A5; the social secrets stay sealed here (this value sits in Redis)
});

export type ResolvedTenant = z.infer<typeof resolvedTenant>;

/** Whether the tenant may sign users in and issue tokens; else `TENANT_SUSPENDED`. */
export const isLive = (tenant: Pick<ResolvedTenant, "status">) =>
  tenant.status === "active";

/** The code of every refusal a suspended or deleted tenant gets. */
export const TENANT_SUSPENDED = "TENANT_SUSPENDED";
