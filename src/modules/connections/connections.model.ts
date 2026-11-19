import {
  defineCollection,
  id,
  type ReadDocumentOf,
  tenantField,
} from "@softistx/mongo";
import { z } from "zod";
import { sealedSecretSchema } from "@/modules/sign-in-methods/sign-in.schema";

/** `claimAndDomain` (default) and `domain` only: `claim` lets the identity provider assert any address, so a tenant cannot pick it here (D2). */
export const CONNECTION_EMAIL_TRUST = ["claimAndDomain", "domain"] as const;
export type ConnectionEmailTrust = (typeof CONNECTION_EMAIL_TRUST)[number];

/** One e-mail domain of a connection: owned only once its TXT record was seen (D3). */
export const connectionDomainSchema = z.object({
  /** Lowercased, punycoded, a strict LDH name (janus `checkConnection`). */
  domain: z.string().max(253),
  /** The TXT value to publish at `_clavix-sso.<domain>`; random, minted per claim. */
  txtToken: z.string(),
  verifiedAt: z.date().nullable().default(null),
  /** The last DNS check, for the cooldown between two checks. */
  checkedAt: z.date().nullable().default(null),
});
export type ConnectionDomain = z.infer<typeof connectionDomainSchema>;

// The enterprise OIDC connections of a tenant (M4, F1; D1-D6, D23).
// Tenant-owned (ADR-0006): read and written only through `scopeToTenant`.
// `connectionId` is the provider name janus's links and events carry, fixed
// for the connection's life. The client secret is sealed (bound to the tenant
// and the connection) and never returned by an API or logged. `revision`
// rises on every write, for the tenant's own bookkeeping.
export const connections = defineCollection({
  name: "connections",
  schema: z.object({
    _id: id(),
    ...tenantField,
    connectionId: z.string().max(32),
    name: z.string().max(100),
    issuer: z.string().max(2000),
    clientId: z.string().max(500),
    secret: sealedSecretSchema,
    clientAuthentication: z.enum(["post", "basic"]).nullable().default(null),
    idTokenSignedResponseAlg: z.string().nullable().default(null),
    scopes: z.array(z.string()).nullable().default(null),
    emailTrust: z.enum(CONNECTION_EMAIL_TRUST).default("claimAndDomain"),
    claims: z
      .object({
        email: z.string().optional(),
        emailVerified: z.string().optional(),
        name: z.string().optional(),
        picture: z.string().optional(),
      })
      .default({}),
    domains: z.array(connectionDomainSchema).default([]),
    /** D4: a verified domain of this connection signs in through it only. */
    requireSso: z.boolean().default(true),
    /** D5: a user is created at the first sign-in (just-in-time), where sign-up is open. */
    jit: z.boolean().default(true),
    /** Whether the sign-in page also offers a button, beside the e-mail home-realm lookup. */
    showButton: z.boolean().default(false),
    /** D6: the `acr` the identity provider must report: janus `stepUp`, a sign-in that lacks it is refused. */
    upstreamMfa: z.object({ acr: z.string() }).nullable().default(null),
    enabled: z.boolean().default(true),
    revision: z.number().int().min(0).default(1),
  }),
  indexes: [
    {
      key: { tenantId: 1, connectionId: 1 },
      unique: true,
      name: "connections_tenant_connection",
    },
    // A backstop of the service's own check: one enabled connection per domain in a tenant.
    {
      key: { tenantId: 1, "domains.domain": 1 },
      unique: true,
      partialFilterExpression: {
        enabled: true,
        "domains.0": { $exists: true },
      },
      name: "connections_tenant_domain_enabled",
    },
  ],
  timestamps: true,
});

export type StoredConnections = typeof connections;

export type ConnectionDoc = ReadDocumentOf<typeof connections>;
