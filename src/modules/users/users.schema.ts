import { z } from "zod";
import { profileFieldsSchema } from "@/modules/profile/profile.schema";

/**
 * An end user of one tenant (ADR-0008). The e-mail is the login; the same
 * address in two tenants is two users, each in its tenant's partition. Beside
 * the display name, the standard profile fields (`profile.schema.ts`), all
 * optional.
 */
export const userSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(200).optional(),
  ...profileFieldsSchema.shape,
});

export type ClavixUser = z.infer<typeof userSchema>;
