import type { ReadDocumentOf, TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { drain } from "@/modules/audit/stream";
import type { adminEvents } from "./admin-events.model";

export type StoredAdminEvent = ReadDocumentOf<typeof adminEvents>;

/** What narrows the console activity; every field is optional and they combine with AND. */
export interface AdminEventFilter {
  from?: Date | null | undefined;
  to?: Date | null | undefined;
  action?: string | null | undefined;
  actor?: string | null | undefined;
}

/** Which tenants' events a read covers: one tenant, the platform's own, or every one. */
export type AdminEventScope =
  | { tenantId: string }
  | { platformOnly: true }
  | { all: true };

/** Events removed per delete, so a long backlog never holds one huge write. */
const BATCH = 1_000;

const whereOf = (scope: AdminEventScope, filter: AdminEventFilter) => ({
  ...("tenantId" in scope
    ? { tenantId: new ObjectId(scope.tenantId) }
    : "platformOnly" in scope
      ? { tenantId: null }
      : {}),
  ...(filter.from == null && filter.to == null
    ? {}
    : {
        at: {
          ...(filter.from == null ? {} : { $gte: filter.from }),
          ...(filter.to == null ? {} : { $lte: filter.to }),
        },
      }),
  ...(filter.action == null ? {} : { action: filter.action }),
  ...(filter.actor == null ? {} : { actor: filter.actor }),
});

/**
 * The read side of `adminEvents` (ADR-0037, M4): paged newest first, and the
 * retention's delete. Like the recorder, the one place besides it that touches the collection.
 */
export class AdminEventReader {
  constructor(
    private readonly collection: TypedCollection<typeof adminEvents>,
  ) {}

  async page(
    scope: AdminEventScope,
    filter: AdminEventFilter,
    page: { after: string | null; limit: number },
  ) {
    const where = whereOf(scope, filter);
    const [found, totalCount] = await Promise.all([
      this.collection.paginateByCursor({
        filter: where,
        orderBy: "at",
        direction: "desc",
        after: page.after,
        limit: page.limit,
      }),
      this.collection.count(where),
    ]);
    return { items: found.items, nextCursor: found.nextCursor, totalCount };
  }

  /** Whether more than `limit` events match (reads at most `limit + 1` index entries, never a full count). */
  async exceeds(
    scope: AdminEventScope,
    filter: AdminEventFilter,
    limit: number,
  ): Promise<boolean> {
    const more = await this.collection.findMany({
      filter: whereOf(scope, filter),
      sort: { at: -1 },
      skip: limit,
      limit: 1,
    });
    return more.length > 0;
  }

  /** The matching events newest first, at most `limit`, read a batch at a time (an export). */
  stream(scope: AdminEventScope, filter: AdminEventFilter, limit: number) {
    const where = whereOf(scope, filter);
    return drain(
      (after, size) =>
        this.collection.paginateByCursor({
          filter: where,
          orderBy: "at",
          direction: "desc",
          after,
          limit: size,
        }),
      limit,
    );
  }

  /**
   * Deletes a tenant's events (`null`: the platform's own) older than
   * `before`, a batch at a time. Answers how many went.
   */
  async deleteBefore(tenantId: string | null, before: Date): Promise<number> {
    const owner = tenantId === null ? null : new ObjectId(tenantId);
    let removed = 0;
    for (;;) {
      const batch = await this.collection.findMany({
        filter: { tenantId: owner, at: { $lt: before } },
        limit: BATCH,
      });
      if (batch.length === 0) return removed;
      removed += await this.collection.deleteMany({
        _id: { $in: batch.map((event) => event._id) },
      });
      if (batch.length < BATCH) return removed;
    }
  }
}
