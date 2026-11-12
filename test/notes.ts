import { defineCollection, id } from "@softistx/mongo";
import { z } from "zod";
import { tenantField } from "@/tenancy/scoped";

// A test-only tenant-owned collection: 1.1 has no real one yet, and the
// scoping and guard specs need one. It is never wired into src/.
export const notes = defineCollection({
  name: "notes",
  schema: z.object({
    _id: id(),
    ...tenantField,
    text: z.string(),
    tags: z.array(z.string()).default([]),
  }),
  indexes: [{ key: { tenantId: 1, text: 1 }, name: "notes_tenant_text" }],
  timestamps: true,
  softDelete: true,
});
