import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

// A tenant's list of clients, for the console. Temporary, until
// @softistx/janus-oauth#706 (nxgt-janus#706): janus-oauth has no `listClients`,
// so this shadow keeps what the console lists (id, name, type, redirect URIs).
// The janus store stays the truth (the console's detail reads it); every
// write goes through `ClientIndex`, and the migration backfills it.
// Tenant-owned (ADR-0006): reached only through `scopeToTenant`.
export const clientIndex = defineCollection({
  name: "clientIndex",
  schema: z.object({
    _id: id(),
    ...tenantField,
    clientId: z.string(),
    name: z.string(),
    type: z.enum(["public", "confidential"]),
    redirectUris: z.array(z.string()),
  }),
  indexes: [
    {
      key: { tenantId: 1, clientId: 1 },
      unique: true,
      name: "clientIndex_tenant_client_unique",
    },
  ],
  timestamps: true,
});
