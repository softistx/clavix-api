import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

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
