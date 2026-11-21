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
    // Whether the resource accepts tokens of the client credentials grant
    // (RFC 6749 section 4.4), which have no user behind them. Absent is
    // `false`, so a stored resource needs no migration.
    allowClientCredentials: z.boolean().optional(),
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

const text = z.object({
  fr: z.string().default(""),
  en: z.string().default(""),
});

export const FIELD_KINDS = [
  "string",
  "number",
  "integer",
  "boolean",
  "enum",
  "string[]",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

// One field of a detail type (D1): a bounded list, never a free JSON Schema.
export const detailField = z.object({
  key: z.string(),
  kind: z.enum(FIELD_KINDS),
  label: text,
  required: z.boolean().default(false),
  // `number` and `integer`: the value's bounds. `string[]`: `max` items.
  min: z.number().optional(),
  max: z.number().optional(),
  // `string` and `string[]` (each item): the longest text.
  maxLength: z.number().optional(),
  // `enum`: the allowed values and their labels.
  values: z.array(z.object({ value: z.string(), label: text })).optional(),
});

// An authorization detail type (RFC 9396) of a resource: the shape of the
// `authorization_details` a client may ask for on it, and the words the
// consent page uses. The `type` is unique in the tenant (D2), so a client's
// opt-in list and `authorization_details_types_supported` are unambiguous.
// Tenant-owned (ADR-0006): reached only through `scopeToTenant`.
export const detailTypes = defineCollection({
  name: "detailTypes",
  schema: z.object({
    _id: id(),
    ...tenantField,
    resourceId: id(),
    type: z.string(),
    name: text,
    description: text,
    fields: z.array(detailField).default([]),
    // The RFC 9396 `actions` the type allows, with their labels.
    actions: z.array(z.object({ value: z.string(), label: text })).optional(),
  }),
  indexes: [
    {
      key: { tenantId: 1, type: 1 },
      unique: true,
      name: "detail_types_tenant_type_unique",
    },
    {
      key: { tenantId: 1, resourceId: 1 },
      name: "detail_types_tenant_resource",
    },
  ],
  timestamps: true,
});
