import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

// An end-user role of a tenant (slice A2c, ADR-0008): its `name` is the value
// of the `roles` claim. `resourceId` scopes it to one resource (API) of the
// tenant, `null` for the whole tenant; the name is unique among the roles of
// one scope (the index treats `null` as a value). Tenant-owned (ADR-0006):
// reached only through `scopeToTenant`, so the tenant purge removes it.
export const roles = defineCollection({
  name: "roles",
  schema: z.object({
    _id: id(),
    ...tenantField,
    name: z.string(),
    description: z.string().default(""),
    resourceId: id().nullable().default(null),
    // A role Clavix itself created for the tenant: the console cannot rename
    // or delete it. Absent on older documents, so `false`.
    managed: z.boolean().default(false),
    // The scopes the role grants (ids of `scopes` documents, ADR-0025). Absent
    // on older documents, so `[]`.
    permissionIds: z.array(id()).default([]),
  }),
  indexes: [
    {
      key: { tenantId: 1, resourceId: 1, name: 1 },
      unique: true,
      name: "roles_tenant_resource_name_unique",
    },
  ],
  timestamps: true,
});

// A role held by a user of the tenant. `userId` is the janus user id of the
// tenant's own pool. Unique per (role, user): an assignment is idempotent.
export const roleAssignments = defineCollection({
  name: "roleAssignments",
  schema: z.object({
    _id: id(),
    ...tenantField,
    roleId: id(),
    userId: z.string(),
  }),
  indexes: [
    {
      key: { tenantId: 1, roleId: 1, userId: 1 },
      unique: true,
      name: "roleAssignments_role_user_unique",
    },
    { key: { tenantId: 1, userId: 1 }, name: "roleAssignments_user" },
  ],
  timestamps: true,
});
