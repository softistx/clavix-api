import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { AuthEvent } from "@/events/types";
import type { authEvents } from "./audit.model";
import type { AuthEventFilter, AuthEventPage } from "./audit.types";
import { drain, filterOf, RETENTION_BATCH, storedEvent } from "./audit.utils";

/**
 * A tenant's sign-in log. Every method takes the tenant's id and reads or
 * writes through that tenant's scope, so an event of A is unknown to B.
 */
export class AuditService {
  constructor(
    private readonly collection: TypedCollection<typeof authEvents>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private scoped(tenantId: string) {
    return scopeToTenant(this.collection, new ObjectId(tenantId));
  }

  /** Appends one event. Field by field: whatever else rides on the input is not stored. */
  async record(event: AuthEvent): Promise<void> {
    await this.scoped(event.tenantId).create(storedEvent(event, this.now()));
  }

  /** One page, newest first, and how many events match in all. */
  async page(
    tenantId: string,
    filter: AuthEventFilter,
    page: { after: string | null; limit: number },
  ): Promise<AuthEventPage> {
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

  /** One event of the tenant by id, or `null` (unknown, malformed id, or another tenant's). */
  async find(tenantId: string, id: string) {
    if (!ObjectId.isValid(id)) return null;
    const found = await this.scoped(tenantId).findById(new ObjectId(id));
    return found ?? null;
  }

  /** Whether more than `limit` events match (reads at most `limit + 1` index entries, never a full count). */
  async exceeds(
    tenantId: string,
    filter: AuthEventFilter,
    limit: number,
  ): Promise<boolean> {
    const more = await this.scoped(tenantId).findMany({
      filter: filterOf(filter),
      sort: { at: -1 },
      skip: limit,
      limit: 1,
    });
    return more.length > 0;
  }

  /** The matching events newest first, at most `limit`, read a batch at a time (an export). */
  stream(tenantId: string, filter: AuthEventFilter, limit: number) {
    const scope = this.scoped(tenantId);
    const where = filterOf(filter);
    return drain(
      (after, size) =>
        scope.paginateByCursor({
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
