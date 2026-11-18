import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

// The rules a client's OAuth grants run under, beyond what janus records on the
// client itself (ADR-0006: tenant-owned, so read and written only through
// `scopeToTenant`). One document per `(tenantId, clientId)`; `clientId` is the
// client's id inside the tenant, as janus knows it.
//
// `tokenExchange` (RFC 8693, M3 decision 7): which resources the client may
// exchange a token for, and whose tokens it may exchange. Delegation only:
// the exchanged token carries `act`. Default-deny: no document, no exchange.
export const tokenExchangeRulesSchema = z.object({
  /** URIs of the tenant's resources the exchanged token may be issued for. */
  targetResources: z.array(z.string()),
  /** Ids of the clients whose tokens may be exchanged, or `"any"`. */
  subjectClients: z.union([z.array(z.string()), z.literal("any")]),
  /** Whether the tokens of any agent of the tenant (D12) may be exchanged too. */
  subjectAgents: z.boolean().default(false),
  mode: z.literal("delegation"),
});
export type TokenExchangeRules = z.infer<typeof tokenExchangeRulesSchema>;

export const clientPolicies = defineCollection({
  name: "clientPolicies",
  schema: z.object({
    _id: id(),
    ...tenantField,
    clientId: z.string(),
    tokenExchange: tokenExchangeRulesSchema.nullable().default(null),
  }),
  indexes: [
    {
      key: { tenantId: 1, clientId: 1 },
      unique: true,
      name: "clientPolicies_tenant_client_unique",
    },
  ],
  timestamps: true,
});

export type StoredClientPolicies = typeof clientPolicies;
