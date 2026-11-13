import { defineCollection, id, objectId } from "@softistx/mongo";
import { z } from "zod";
import { AUDIT_ACTION } from "../audit";

// What the console did (ADR-0037): one document per recorded action, written
// by `ctx.audit` and never changed or removed afterwards (no timestamps, no
// soft delete, no version: nothing here updates). The schema is closed and has
// no free-form field, so a secret value, or a before/after of one, has nowhere
// to go: an event names its target, never its content.
//
// A platform collection, not a tenant-owned one (`src/tenancy/owned.ts`):
// `tenantId` is the tenant the action was about, `null` for an action on the
// platform itself, and operators read across tenants (the viewer, M4).
export const adminEvents = defineCollection({
  name: "adminEvents",
  schema: z.strictObject({
    _id: id(),
    /** Who did it: the id of a user of the `clavix` tenant. */
    actor: z.string().min(1).max(200),
    action: z.string().max(100).regex(AUDIT_ACTION),
    tenantId: objectId().nullable(),
    /** What it was done to, by kind and id. Never a value. */
    target: z.strictObject({
      type: z.string().min(1).max(100),
      id: z.string().min(1).max(200),
    }),
    at: z.date(),
    /** The console request that did it: the events of one request share it. */
    requestId: z.string().min(1).max(100),
  }),
  indexes: [
    { key: { tenantId: 1, at: -1 }, name: "adminEvents_tenant_at" },
    { key: { actor: 1, at: -1 }, name: "adminEvents_actor_at" },
  ],
});
