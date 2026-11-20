import type { StoredAuthEvent } from "@/modules/audit/auth-events.service";
import type { StoredAdminEvent } from "../admin-events/reader";

/** One exported row: column name to text (`null`: an empty cell). */
export type Row = Record<string, string | null>;

export const ADMIN_COLUMNS = [
  "id",
  "at",
  "action",
  "actor",
  "targetType",
  "targetId",
  "tenantId",
  "requestId",
] as const;

export const AUTH_COLUMNS = [
  "id",
  "at",
  "type",
  "outcome",
  "reason",
  "method",
  "actorKind",
  "actorId",
  "userId",
  "clientId",
  "ip",
  "userAgent",
  "requestId",
] as const;

export const adminRow = (event: StoredAdminEvent): Row => ({
  id: event._id.toHexString(),
  at: event.at.toISOString(),
  action: event.action,
  actor: event.actor,
  targetType: event.target.type,
  targetId: event.target.id,
  tenantId: event.tenantId?.toHexString() ?? null,
  requestId: event.requestId,
});

export const authRow = (event: StoredAuthEvent): Row => ({
  id: event._id.toHexString(),
  at: event.at.toISOString(),
  type: event.type,
  outcome: event.outcome,
  reason: event.reason,
  method: event.method,
  actorKind: event.actor.kind,
  actorId: event.actor.id,
  userId: event.userId,
  clientId: event.clientId,
  ip: event.ip,
  userAgent: event.userAgent,
  requestId: event.requestId,
});

export async function* mapRows<T>(
  source: AsyncIterable<T>,
  row: (item: T) => Row,
): AsyncGenerator<Row> {
  for await (const item of source) yield row(item);
}
