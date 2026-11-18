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
export const AGENT_MODES = ["off", "restricted", "open"] as const;

/**
 * Agents (M3, decisions D7, D8): MCP clients and other apps that register
 * themselves. `dynamic` is RFC 7591 registration (`restricted`: janus's MCP
 * client redirect URIs plus `redirectUris`; `open`: any valid redirect URI),
 * `metadataDocuments` the Client ID Metadata Documents of the MCP hosts plus
 * `allowHosts`. Off by default, so a tenant stored before the field existed, and
 * a resolved tenant cached before it, serve nobody.
 */
export const agentsPolicySchema = z
  .object({
    dynamic: z.enum(AGENT_MODES).default("off"),
    redirectUris: z.array(z.string()).default([]),
    metadataDocuments: z.boolean().default(false),
    allowHosts: z.array(z.string()).default([]),
  })
  .default({
    dynamic: "off",
    redirectUris: [],
    metadataDocuments: false,
    allowHosts: [],
  });
export type AgentsPolicy = z.infer<typeof agentsPolicySchema>;

export const agentsOff = (): AgentsPolicy => ({
  dynamic: "off",
  redirectUris: [],
  metadataDocuments: false,
  allowHosts: [],
});

export const oauthPolicySchema = z
  .object({
    par: z.object({ required: z.boolean().default(false) }).default({
      required: false,
    }),
    dpop: z.object({ required: z.boolean().default(false) }).default({
      required: false,
    }),
    agents: agentsPolicySchema,
  })
  .default({
    par: { required: false },
    dpop: { required: false },
    agents: agentsOff(),
  });
export type OAuthPolicy = z.infer<typeof oauthPolicySchema>;

/** The policy a new tenant starts with: pushed authorization requests required. */
export const newTenantOAuthPolicy = (): OAuthPolicy => ({
  par: { required: true },
  dpop: { required: false },
  agents: agentsOff(),
});
