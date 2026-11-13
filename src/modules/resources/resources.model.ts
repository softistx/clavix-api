import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

// A protected resource (an API) of a tenant, RFC 8707: `uri` is the audience of
// the access tokens issued for it, `scopes` what a client may ask on it.
// Tenant-owned (ADR-0006): read and written only through `scopeToTenant`, so a
// resource of one tenant is never served to another. Its scopes are `Scope` documents
// (scopes.model.ts) that point back to it.
export const resources = defineCollection({
  name: "resources",
  schema: z.object({
    _id: id(),
    ...tenantField,
    uri: z.string(),
    name: z.string(),
    // Legacy: the scopes were a plain list here before the console. The
    // `scopes` collection is the truth now; the 2026-11-13 migration moves
    // the strings there and removes this field.
    scopes: z.array(z.string()).optional(),
  }),
  indexes: [
    {
      key: { tenantId: 1, uri: 1 },
      unique: true,
      name: "resources_tenant_uri_unique",
    },
  ],
  timestamps: true,
});

export type StoredResource = typeof resources;
