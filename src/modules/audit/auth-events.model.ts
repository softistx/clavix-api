import { defineCollection, id, tenantField } from "@softistx/mongo";
import { z } from "zod";

/**
 * What the sign-in log records (D14), closed. A type is `<noun>.<verb>`. Per-token
 * events (issued, refreshed, introspected) are never recorded: they go to telemetry only.
 */
export const AUTH_EVENT_TYPES = [
  "session.signIn",
  "session.signOut",
  "stepUp.confirm",
  "passkey.added",
  "passkey.removed",
  "passkey.cloneSuspected",
  "secondFactor.enabled",
  "secondFactor.disabled",
  "recoveryCodes.regenerated",
  "recoveryCode.used",
] as const;
export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

export const isAuthEventType = (value: string): value is AuthEventType =>
  (AUTH_EVENT_TYPES as readonly string[]).includes(value);

export const AUTH_OUTCOMES = ["success", "failure"] as const;
export type AuthOutcome = (typeof AUTH_OUTCOMES)[number];

/** How a user proved who they are at a sign-in or a step-up. */
export const AUTH_METHODS = [
  "emailCode",
  "magicLink",
  "passkey",
  "social",
  "totp",
  "recoveryCode",
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const ACTOR_KINDS = ["user", "client", "system"] as const;

// What a tenant's users did to their own access (D12): one document per event,
// appended by the event bus and removed only by the retention job or a tenant
// purge. Tenant-owned (ADR-0006): reached through `scopeToTenant` only. The
// schema is closed, with no free-form field: an event names who, what, when and
// from where, never a code, a token or a secret. The full IP is kept for the
// retention period only (D15): it never goes into a webhook or telemetry.
export const authEvents = defineCollection({
  name: "authEvents",
  schema: z.strictObject({
    _id: id(),
    ...tenantField,
    type: z.enum(AUTH_EVENT_TYPES),
    at: z.date(),
    outcome: z.enum(AUTH_OUTCOMES),
    /** Why a failure failed, or a short code of the success; a code, never a message. */
    reason: z.string().max(100).nullable(),
    /** The method of a sign-in or step-up; `null` for the other types. */
    method: z.enum(AUTH_METHODS).nullable(),
    /** Who did it: the user (`anonymous` when a failed sign-in names none), a client, or the system. */
    actor: z.strictObject({
      kind: z.enum(ACTOR_KINDS),
      id: z.string().min(1).max(200),
    }),
    userId: z.string().min(1).max(200).nullable(),
    clientId: z.string().min(1).max(200).nullable(),
    /** The client address, in full; `null` when the source has none (a janus event). */
    ip: z.string().max(64).nullable(),
    /** A browser or tool family (`Firefox`, `curl`), never the whole User-Agent. */
    userAgent: z.string().max(40).nullable(),
    requestId: z.string().min(1).max(100),
  }),
  indexes: [
    { key: { tenantId: 1, at: -1 }, name: "authEvents_tenant_at" },
    {
      key: { tenantId: 1, userId: 1, at: -1 },
      name: "authEvents_tenant_user_at",
    },
    {
      key: { tenantId: 1, type: 1, at: -1 },
      name: "authEvents_tenant_type_at",
    },
  ],
});
