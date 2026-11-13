import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

// A scope of a tenant (ADR-0025): what a client may ask for, with the text the
// consent page shows in French and English, the resource it belongs to (`null`
// for a standard OpenID Connect scope such as `openid`) and the claims it
// opens. The name is the OAuth scope token, unique in its resource (and among
// the standard ones): an access token is for one resource (RFC 8707), so two
// APIs of a tenant may each have their own `read`.
// Tenant-owned (ADR-0006): reached only through `scopeToTenant`.
export const scopes = defineCollection({
  name: "scopes",
  schema: z.object({
    _id: id(),
    ...tenantField,
    name: z.string(),
    description: z.object({
      fr: z.string().default(""),
      en: z.string().default(""),
    }),
    resourceId: id().nullable().default(null),
    claims: z.array(z.string()).default([]),
  }),
  indexes: [
    {
      key: { tenantId: 1, resourceId: 1, name: 1 },
      unique: true,
      name: "scopes_tenant_resource_name_unique",
    },
  ],
  timestamps: true,
});
