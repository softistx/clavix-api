import { z } from "zod";

// The standard profile fields as janus stores them on a user (slice A4): all
// optional, none required, so no migration. `null` is a field cleared by a
// write (janus replaces a named field whole and has no "unset"); a read treats
// it as absent. Only the shape is held here; the rules of each field
// (E.164, BCP 47, IANA, ISO 3166) are in `rules/profile.rules.ts`, which checks
// an input before it reaches this schema. A leaf file (`users.schema.ts` and
// the profile code import it).
const text = z.string().min(1).max(100);
const part = z.string().min(1).max(200);

export const addressSchema = z.object({
  formatted: z.string().min(1).max(500).optional(),
  streetAddress: part.optional(),
  locality: part.optional(),
  region: part.optional(),
  postalCode: part.optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});

export const phoneSchema = z.object({
  number: z.string().regex(/^\+[1-9]\d{6,14}$/),
  verified: z.boolean(),
});

export const profileFieldsSchema = z.object({
  givenName: text.nullable().optional(),
  familyName: text.nullable().optional(),
  nickname: text.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  locale: z.string().min(2).max(35).nullable().optional(),
  zoneinfo: z.string().min(1).max(64).nullable().optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  address: addressSchema.nullable().optional(),
});
