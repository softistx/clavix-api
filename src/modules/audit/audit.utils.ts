import type { AuthEvent } from "@/events/types";
import { userAgentFamily } from "@/events/user-agent";
import type { AuthEventFilter } from "./audit.types";

/** Events removed per delete, so a long backlog never holds one huge write. */
export const RETENTION_BATCH = 1_000;

/** The mongo filter of a sign-in log filter: the set fields, combined with AND. */
export const filterOf = (filter: AuthEventFilter) => {
  const { from, to, types, userId, clientId, outcome } = {
    from: filter.from ?? undefined,
    to: filter.to ?? undefined,
    types: filter.types ?? undefined,
    userId: filter.userId ?? undefined,
    clientId: filter.clientId ?? undefined,
    outcome: filter.outcome ?? undefined,
  };
  return {
    ...(from === undefined && to === undefined
      ? {}
      : {
          at: {
            ...(from === undefined ? {} : { $gte: from }),
            ...(to === undefined ? {} : { $lte: to }),
          },
        }),
    ...(types === undefined || types.length === 0
      ? {}
      : { type: { $in: [...types] } }),
    ...(userId === undefined ? {} : { userId }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(outcome === undefined ? {} : { outcome }),
  };
};

/** The stored fields of an event, field by field: whatever else rides on the input is not stored. */
export const storedEvent = (event: AuthEvent, now: Date) => ({
  type: event.type,
  at: event.at ?? now,
  outcome: event.outcome,
  reason: event.reason ?? null,
  method: event.method ?? null,
  actor:
    event.clientId !== undefined && event.userId === undefined
      ? ({ kind: "client", id: event.clientId } as const)
      : ({ kind: "user", id: event.userId ?? "anonymous" } as const),
  userId: event.userId ?? null,
  clientId: event.clientId ?? null,
  ip: event.ip ?? null,
  userAgent: userAgentFamily(event.userAgent),
  requestId: event.requestId ?? crypto.randomUUID(),
});

/** Rows read per round trip when an export walks a log: memory stays flat whatever the log's size. */
export const EXPORT_BATCH = 500;

/**
 * Walks a cursor-paged read to its end (or `limit` rows), one batch at a time,
 * so a caller holds one batch whatever the log's size.
 */
export async function* drain<T>(
  read: (
    after: string | null,
    size: number,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
  limit: number,
): AsyncGenerator<T> {
  let after: string | null = null;
  let left = limit;
  while (left > 0) {
    const page = await read(after, Math.min(EXPORT_BATCH, left));
    for (const item of page.items) yield item;
    left -= page.items.length;
    if (page.nextCursor === null || page.items.length === 0) return;
    after = page.nextCursor;
  }
}
