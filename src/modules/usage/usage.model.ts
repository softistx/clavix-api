import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

// What a tenant's month ended at, kept out of Redis: one document per tenant
// and month, written when the usage is read (the larger of the stored and the
// counted value, since the estimate of a month only grows). Tenant-owned
// (ADR-0006): reached through `scopeToTenant` only.
export const usageCounters = defineCollection({
  name: "usageCounters",
  schema: z.object({
    _id: id(),
    ...tenantField,
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    mau: z.number().int().min(0),
  }),
  indexes: [
    {
      key: { tenantId: 1, month: 1 },
      unique: true,
      name: "usageCounters_tenant_month_unique",
    },
  ],
  timestamps: true,
});
