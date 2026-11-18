import {
  type ReadDocumentOf,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { AuthEvent } from "@/events/types";
import { userAgentFamily } from "@/events/user-agent";
import type { AuthEventType, authEvents } from "./auth-events.model";

export type StoredAuthEvent = ReadDocumentOf<typeof authEvents>;

/** What narrows the sign-in log; every field is optional and they combine with AND. */
export interface AuthEventFilter {
  from?: Date | null | undefined;
  to?: Date | null | undefined;
  types?: readonly AuthEventType[] | null | undefined;
  userId?: string | null | undefined;
  clientId?: string | null | undefined;
  outcome?: "success" | "failure" | null | undefined;
}

/** Events removed per delete, so a long backlog never holds one huge write. */
export const RETENTION_BATCH = 1_000;

export const filterOf = (filter: AuthEventFilter) => ({
  ...(filter.from == null && filter.to == null
    ? {}
    : {
        at: {
          ...(filter.from == null ? {} : { $gte: filter.from }),
          ...(filter.to == null ? {} : { $lte: filter.to }),
        },
      }),
  ...(filter.types == null || filter.types.length === 0
    ? {}
    : { type: { $in: [...filter.types] } }),
  ...(filter.userId == null ? {} : { userId: filter.userId }),
  ...(filter.clientId == null ? {} : { clientId: filter.clientId }),
  ...(filter.outcome == null ? {} : { outcome: filter.outcome }),
});

/**
 * A tenant's sign-in log. Every method takes the tenant's id and reads or
 * writes through that tenant's scope, so an event of A is unknown to B.
 */
export class AuthEventsService {
  constructor(
    private readonly collection: TypedCollection<typeof authEvents>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private scoped(tenantId: string) {
    return scopeToTenant(this.collection, new ObjectId(tenantId));
  }

  /** Appends one event. Field by field: whatever else rides on the input is not stored. */
  async record(event: AuthEvent): Promise<void> {
    await this.scoped(event.tenantId).create({
      type: event.type,
      at: event.at ?? this.now(),
      outcome: event.outcome,
      reason: event.reason ?? null,
      method: event.method ?? null,
      actor:
        event.clientId !== undefined && event.userId === undefined
          ? { kind: "client", id: event.clientId }
          : { kind: "user", id: event.userId ?? "anonymous" },
      userId: event.userId ?? null,
      clientId: event.clientId ?? null,
      ip: event.ip ?? null,
      userAgent: userAgentFamily(event.userAgent),
      requestId: event.requestId ?? crypto.randomUUID(),
    });
  }

  /** One page, newest first, and how many events match in all. */
  async page(
    tenantId: string,
    filter: AuthEventFilter,
    page: { after: string | null; limit: number },
  ) {
    const scope = this.scoped(tenantId);
    const where = filterOf(filter);
    const [found, totalCount] = await Promise.all([
      scope.paginateByCursor({
        filter: where,
        orderBy: "at",
        direction: "desc",
        after: page.after,
        limit: page.limit,
      }),
      scope.count(where),
    ]);
    return { items: found.items, nextCursor: found.nextCursor, totalCount };
  }

  /**
   * Deletes the tenant's events older than `before`, `RETENTION_BATCH` at a
   * time, until none is left. Answers how many went.
   */
  async deleteBefore(tenantId: string, before: Date): Promise<number> {
    const scope = this.scoped(tenantId);
    let removed = 0;
    for (;;) {
      const batch = await scope.findMany({
        filter: { at: { $lt: before } },
        limit: RETENTION_BATCH,
      });
      if (batch.length === 0) return removed;
      removed += await scope.deleteMany({
        _id: { $in: batch.map((event) => event._id) },
      });
      if (batch.length < RETENTION_BATCH) return removed;
    }
  }
}
