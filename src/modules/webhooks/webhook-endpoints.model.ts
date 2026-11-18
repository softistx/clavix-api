import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";
import { sealedSecretSchema } from "@/modules/sign-in-methods/sign-in.schema";

/** Why an endpoint is off: `givenUp` is D20's auto-disable, `manual` the tenant's own switch. */
export const DISABLED_REASONS = ["givenUp", "manual"] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];

/** One signing secret of an endpoint, sealed (D19). A rolled one stays until `expiresAt`. */
export const endpointSecretSchema = z.object({
  /** A short id of the secret, so a roll can name it; not secret. */
  sid: z.string(),
  sealed: sealedSecretSchema,
  createdAt: z.date(),
  /** `null` for the current secret; a rolled one keeps signing until then. */
  expiresAt: z.date().nullable().default(null),
});
export type EndpointSecret = z.infer<typeof endpointSecretSchema>;

// The webhook endpoints of a tenant (M4, W1; decisions D19-D22). Tenant-owned
// (ADR-0006): read and written only through `scopeToTenant`. The `_id` is the
// endpoint's id for janus-webhooks' queue (24 hex characters). `types` empty
// means every type of the catalogue. The secrets are never returned by an API
// or logged; the newest comes first.
export const webhookEndpoints = defineCollection({
  name: "webhookEndpoints",
  schema: z.object({
    _id: id(),
    ...tenantField,
    url: z.string().max(2000),
    description: z.string().max(200).default(""),
    types: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
    secrets: z.array(endpointSecretSchema).default([]),
    /** Deliveries given up in a row; reset by a delivered one (D20). */
    consecutiveGiveUps: z.number().int().min(0).default(0),
    disabledReason: z.enum(DISABLED_REASONS).nullable().default(null),
  }),
  indexes: [
    {
      key: { tenantId: 1, createdAt: 1 },
      name: "webhookEndpoints_tenant_created",
    },
    // The expired-secret job: the endpoints of a tenant that hold a rolled secret.
    {
      key: { tenantId: 1, "secrets.expiresAt": 1 },
      name: "webhookEndpoints_tenant_secretExpiry",
    },
  ],
  timestamps: true,
});

export type StoredWebhookEndpoints = typeof webhookEndpoints;
