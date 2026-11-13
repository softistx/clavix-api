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
  issuer: z.string(),
  partition: z.string(),
  version: z.number(),
  signIn: signInPolicySchema, // slice A5; the social secrets stay sealed here (this value sits in Redis)
});

export type ResolvedTenant = z.infer<typeof resolvedTenant>;
