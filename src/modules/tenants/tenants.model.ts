import { defineCollection, id, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";

// The platform collection of tenants: read unscoped, by platform code only
// (src/modules/tenants and src/migrations). `version` (optimistic lock) rises
// on every update, so it is the `version` of a ResolvedTenant: any change to a
// tenant invalidates what was derived from it.
export const tenants = defineCollection({
  name: "tenants",
  schema: z.object({
    _id: id(),
    slug: z.string(),
    name: z.string(),
    status: z.enum(["active", "suspended"]).default("active"),
  }),
  indexes: [
    {
      key: { slug: 1 },
      unique: true,
      name: "tenants_slug_unique",
      partialFilterExpression: { deletedAt: null },
    },
  ],
  timestamps: true,
  softDelete: true,
  optimisticLock: true,
});

export type Tenant = ReadDocumentOf<typeof tenants>;
export type TenantStatus = Tenant["status"];
