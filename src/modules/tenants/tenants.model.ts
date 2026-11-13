import { defineCollection, id, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import { signInPolicySchema } from "@/modules/sign-in-methods/sign-in.schema";
import { planFields } from "./plan.schema";
import { trashFields } from "./trash.schema";

// A slug is reserved for good: the unique index is not partial, so a deleted
// tenant keeps its slug (its issuer was registered by relying parties).
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
    // Whether an unknown e-mail may open an account by signing in with a code.
    // Closed by default (and for a tenant stored before the flag existed): the
    // users come in by invitation. The `clavix` tenant stays closed.
    signUp: z.boolean().default(false),
    signIn: signInPolicySchema, // slice A5: methods and social apps (sign-in.schema.ts)
    ...planFields,
    ...trashFields,
  }),
  indexes: [
    {
      key: { slug: 1 },
      unique: true,
      name: "tenants_slug_unique",
    },
  ],
  timestamps: true,
  softDelete: true,
  optimisticLock: true,
});

export type Tenant = ReadDocumentOf<typeof tenants>;
export type TenantStatus = Tenant["status"];
