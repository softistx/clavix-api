import { z } from "zod";

/**
 * An end user of one tenant (ADR-0008). The e-mail is the login; the same
 * address in two tenants is two users, each in its tenant's partition.
 */
export const userSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(200).optional(),
});

export type ClavixUser = z.infer<typeof userSchema>;
