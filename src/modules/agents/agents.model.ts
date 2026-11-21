import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

export const AGENT_KINDS = ["dynamic", "metadata"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// The agents of a tenant (M3, decision D15): the clients that registered
// themselves (`dynamic`, RFC 7591) or that a Client ID Metadata Document
// describes (`metadata`, recorded on their first `/authorize`). Tenant-owned
// (ADR-0006): read and written only through `scopeToTenant`. One document per
// `(tenantId, clientId)`, `clientId` being the id inside the tenant as janus
// knows it. `createdAt` is the registration time. It serves the `agents`
// quota, the clean-up job and the console; it is not the client itself, which
// janus stores.
export const agentClients = defineCollection({
  name: "agentClients",
  schema: z.object({
    _id: id(),
    ...tenantField,
    clientId: z.string(),
    kind: z.enum(AGENT_KINDS),
    /** A short digest of the registering address and the tenant, never the address itself. */
    ipDigest: z.string().nullable().default(null),
  }),
  indexes: [
    {
      key: { tenantId: 1, clientId: 1 },
      unique: true,
      name: "agentClients_tenant_client_unique",
    },
    // The clean-up job: a tenant's agents of one kind, oldest first.
    {
      key: { tenantId: 1, kind: 1, createdAt: 1 },
      name: "agentClients_tenant_kind_created",
    },
  ],
  timestamps: true,
});

export type StoredAgentClients = typeof agentClients;
