import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

/**
 * The profile fields a tenant may lock for self-service: the display name,
 * the standard OpenID Connect ones and the picture. The e-mail has its own
 * proof (`changeEmail`), so it is not here.
 */
export const PROFILE_FIELDS = [
  "NAME",
  "GIVEN_NAME",
  "FAMILY_NAME",
  "NICKNAME",
  "PHONE",
  "PICTURE",
  "LOCALE",
  "ZONEINFO",
  "BIRTHDATE",
  "ADDRESS",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

// The profile fields a tenant locks for its users' self-service (user-attributes
// plan, slice A4). Tenant-owned (ADR-0006): reached only through
// `scopeToTenant`, so the tenant purge removes it. One document per tenant
// (unique `tenantId`), and a document of its own: changing it does not bump the
// tenant's `version`, so no janus instance is rebuilt. `version` (the optimistic
// lock) answers a stale write, and the loser of a first-write race, with
// `CONFLICT`. No document means nothing is locked.
export const profilePolicies = defineCollection({
  name: "profilePolicies",
  schema: z.object({
    _id: id(),
    ...tenantField,
    locked: z.array(z.enum(PROFILE_FIELDS)).default([]),
  }),
  indexes: [
    {
      key: { tenantId: 1 },
      unique: true,
      name: "profilePolicies_tenant_unique",
    },
  ],
  timestamps: true,
  optimisticLock: true,
});

export type StoredProfilePolicies = typeof profilePolicies;
