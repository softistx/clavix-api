import { defineCollection, id, objectId } from "@softistx/mongo";
import { z } from "zod";

export const DOMAIN_STATUSES = ["pending", "verified", "unverified"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

// A tenant's custom domains (slice A4, ADR-0015). A PLATFORM collection, not a
// tenant-owned one (`src/tenancy/owned.ts`): `tenantId` says whose claim a
// document is, but the uniqueness that matters crosses tenants (a host is
// served by one tenant only), and the resolver and the TLS ask read by host.
// It is reached through `DomainStore` alone (the platform scan in
// guards.spec.ts). The purge removes a tenant's documents (`deleteOwnedBy`).
//
// Several tenants may hold a `pending` claim on one host (an unverified claim
// never blocks the real owner); the partial unique index lets only one be
// `verified`. `unverified` is a verified domain whose record failed its
// recheck for 7 days.
export const domains = defineCollection({
  name: "domains",
  schema: z.object({
    _id: id(),
    tenantId: objectId(),
    /** Normalised (`normalizeDomainHost`). */
    host: z.string().max(253),
    status: z.enum(DOMAIN_STATUSES).default("pending"),
    /** The TXT value to publish at `_clavix.<host>`: random, minted per claim. */
    txtToken: z.string(),
    /** The tenant's issuer host (ADR-0032). At most one per tenant, always `verified`. */
    primary: z.boolean().default(false),
    verifiedAt: z.date().nullable().default(null),
    checkedAt: z.date().nullable().default(null),
    /** Since when the recheck fails; `null` while it passes. */
    failingSince: z.date().nullable().default(null),
  }),
  indexes: [
    {
      key: { host: 1 },
      unique: true,
      partialFilterExpression: { status: "verified" },
      name: "domains_host_verified_unique",
    },
    {
      key: { tenantId: 1, host: 1 },
      unique: true,
      name: "domains_tenant_host",
    },
    { key: { status: 1, checkedAt: 1 }, name: "domains_status_checked" },
  ],
  timestamps: true,
});
