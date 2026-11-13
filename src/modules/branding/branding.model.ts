import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

// A tenant's brand (slice A3): at most one document per tenant, tenant-owned
// (ADR-0006), so it is read and written only through `scopeToTenant`. `css` is
// the generated theme (`themeToCss`, attribute scope), stored so the hosted
// pages serve it without compiling; the logo (a small raster image) is stored
// inline as base64 with its hash, which is its ETag. `version` (the optimistic
// lock) is what makes two concurrent `updateBranding` calls apply one after
// the other instead of one overwriting what the other just decided.
export const branding = defineCollection({
  name: "branding",
  schema: z.object({
    _id: id(),
    ...tenantField,
    displayName: z.string(),
    seed: z.string(),
    radius: z.string(),
    backgroundPreset: z.string().nullable().default(null),
    motif: z.string().nullable().default(null),
    css: z.string(),
    logo: z
      .object({
        contentType: z.string(),
        data: z.string(),
        hash: z.string(),
        size: z.number(),
      })
      .nullable()
      .default(null),
  }),
  indexes: [
    { key: { tenantId: 1 }, unique: true, name: "branding_tenant_unique" },
  ],
  timestamps: true,
  optimisticLock: true,
});

export type StoredBranding = typeof branding;
