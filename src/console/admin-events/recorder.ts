import type { TypedCollection } from "@softistx/mongo";
import type { AuditAction } from "../audit";
import type { adminEvents } from "./admin-events.model";

/** One admin event, as `ctx.audit` hands it over. `at` is set here. */
export interface AdminEventInput {
  actor: string;
  action: AuditAction;
  /** The tenant's hex id, or `null` for an action on the platform. */
  tenantId: string | null;
  target: { type: string; id: string };
  requestId: string;
}

/** The one way into `adminEvents`: it appends, and offers nothing else. */
export interface AdminEventRecorder {
  /** Stores the event; rejects when it is refused or the database is down. */
  record(event: AdminEventInput): Promise<void>;
}

export function createAdminEventRecorder(
  collection: TypedCollection<typeof adminEvents>,
  now: () => Date,
): AdminEventRecorder {
  return {
    async record({ actor, action, tenantId, target, requestId }) {
      // Field by field: whatever else rides on `target` is not stored.
      await collection.create({
        actor,
        action,
        tenantId,
        target: { type: target.type, id: target.id },
        at: now(),
        requestId,
      });
    },
  };
}
