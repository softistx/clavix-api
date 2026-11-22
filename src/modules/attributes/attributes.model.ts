import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";
import { translationsSchema } from "@/shared/translations";

/** Who an attribute describes: every user of the tenant, or the holders of the roles it is linked to. */
export const ATTRIBUTE_FAMILIES = ["USER", "ROLE"] as const;
export type AttributeFamily = (typeof ATTRIBUTE_FAMILIES)[number];

/** What an attribute holds; its values are canonical per type (plan "attributeValues"). */
export const ATTRIBUTE_TYPES = [
  "STRING",
  "TEXT",
  "COLOR",
  "NUMBER",
  "DATE",
  "DATETIME",
  "TIME",
  "SELECT",
  "MULTI_SELECT",
  "BOOLEAN",
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** One choice of a SELECT or MULTI_SELECT attribute: its `key` is the stored (and emitted) value. */
export const attributeOptionSchema = z.object({
  key: z.string(),
  label: translationsSchema,
});
export type AttributeOption = z.infer<typeof attributeOptionSchema>;

// The attribute catalogue of a tenant (user-attributes plan, slice A1): the
// definitions of the extra fields its users (family `user`) or the holders of
// some roles (family `role`) carry. Tenant-owned (ADR-0006): reached only
// through `scopeToTenant`, so the tenant purge removes it. The `key` never
// changes (it is the claim name) and stays held while the attribute is
// archived; only the permanent delete frees it. `position` is a gapped number:
// a move writes one document, never its siblings. `version` (the optimistic
// lock) answers a stale write with `CONFLICT`.
export const userAttributes = defineCollection({
  name: "userAttributes",
  schema: z.object({
    _id: id(),
    ...tenantField,
    key: z.string(),
    family: z.enum(ATTRIBUTE_FAMILIES),
    type: z.enum(ATTRIBUTE_TYPES),
    label: translationsSchema,
    description: translationsSchema,
    unit: z.string().nullable().default(null),
    options: z.array(attributeOptionSchema).default([]),
    required: z.boolean().default(false),
    userEditable: z.boolean().default(false),
    unique: z.boolean().default(false),
    emission: z.object({ scope: z.string() }).nullable().default(null),
    position: z.number(),
    archivedAt: z.date().nullable().default(null),
  }),
  indexes: [
    {
      key: { tenantId: 1, key: 1 },
      unique: true,
      name: "userAttributes_tenant_key_unique",
    },
    {
      key: { tenantId: 1, family: 1, archivedAt: 1, position: 1 },
      name: "userAttributes_tenant_family_archived_position",
    },
  ],
  timestamps: true,
  optimisticLock: true,
});

/** What a stored value holds, canonical per type (a `Date` for DATE and DATETIME, the option keys for a choice). */
export const storedValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.date(),
  z.array(z.string()),
]);
export type StoredValue = z.infer<typeof storedValueSchema>;

// A user's value of an attribute (user-attributes plan, slice A2). Tenant-owned
// (ADR-0006): reached only through `scopeToTenant`, purged with the tenant.
// `type` is copied from the attribute at write time: a read ignores a value
// whose type no longer matches (risk 3). `uniqueKey` is the normalised value of
// a `unique` attribute (null otherwise), under a partial unique index.
export const attributeValues = defineCollection({
  name: "attributeValues",
  schema: z.object({
    _id: id(),
    ...tenantField,
    userId: z.string(),
    attributeId: id(),
    type: z.enum(ATTRIBUTE_TYPES),
    value: storedValueSchema,
    uniqueKey: z.string().nullable().default(null),
    updatedBy: z.object({ kind: z.enum(["admin", "user"]), id: z.string() }),
  }),
  indexes: [
    {
      key: { tenantId: 1, userId: 1, attributeId: 1 },
      unique: true,
      name: "attributeValues_user_attribute_unique",
    },
    {
      key: { tenantId: 1, attributeId: 1, uniqueKey: 1 },
      unique: true,
      partialFilterExpression: { uniqueKey: { $type: "string" } },
      name: "attributeValues_attribute_unique_key",
    },
    {
      key: { tenantId: 1, attributeId: 1, value: 1 },
      name: "attributeValues_attribute_value",
    },
  ],
  timestamps: true,
});

// The link between a role-family attribute and one precise role (user-attributes
// plan, slice A3): a role is per tenant and per resource, so a link names the
// role, never a role name. `required` is per link (the attribute's own flag is
// user-family only). Tenant-owned (ADR-0006), purged with the tenant. The links
// of a role go with the role, those of an attribute with its permanent delete;
// the values stay (hidden at read and at emission).
export const roleAttributes = defineCollection({
  name: "roleAttributes",
  schema: z.object({
    _id: id(),
    ...tenantField,
    roleId: id(),
    attributeId: id(),
    required: z.boolean().default(false),
  }),
  indexes: [
    {
      key: { tenantId: 1, roleId: 1, attributeId: 1 },
      unique: true,
      name: "roleAttributes_role_attribute_unique",
    },
    {
      key: { tenantId: 1, attributeId: 1 },
      name: "roleAttributes_attribute",
    },
  ],
  timestamps: true,
});
