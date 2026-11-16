import { z } from "zod";

/**
 * A tenant's OAuth policy (M3): the tenant document's `oauth` field and
 * `ResolvedTenant.oauth`. `par.required` makes every client of the tenant
 * push its authorization requests (RFC 9126); `dpop.required` is the same for
 * DPoP-bound tokens (RFC 9449, used by a later slice). Every flag defaults to
 * `false`, so a tenant stored before the policy existed, and a resolved tenant
 * cached before it, stay as they were (the migration `2026-11-16-oauth-policy`
 * writes the `false` explicitly).
 */
export const oauthPolicySchema = z
  .object({
    par: z.object({ required: z.boolean().default(false) }).default({
      required: false,
    }),
    dpop: z.object({ required: z.boolean().default(false) }).default({
      required: false,
    }),
  })
  .default({ par: { required: false }, dpop: { required: false } });
export type OAuthPolicy = z.infer<typeof oauthPolicySchema>;

/** The policy a new tenant starts with: pushed authorization requests required. */
export const newTenantOAuthPolicy = (): OAuthPolicy => ({
  par: { required: true },
  dpop: { required: false },
});
