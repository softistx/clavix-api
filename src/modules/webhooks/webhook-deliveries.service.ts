import {
  type ReadDocumentOf,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import {
  DELIVERIES_PER_ENDPOINT,
  type webhookDeliveries,
} from "./webhook-deliveries.model";

export type WebhookDeliveryDoc = ReadDocumentOf<typeof webhookDeliveries>;

/** What `onAttempt` reports, reduced to what is kept: no URL, no body. */
export interface AttemptRecord {
  endpointId: string;
  eventId: string;
  type: string;
  attempt: number;
  status: number | null;
  error: string | null;
  durationMs: number;
  delivered: boolean;
  willRetry: boolean;
}

/** The attempts a console page shows at most. */
export const MAX_LISTED = DELIVERIES_PER_ENDPOINT;

/**
 * The delivery attempts of a tenant's endpoints (M4 W2): the last 100 per
 * endpoint, 7 days (the collection's TTL). Every method takes the tenant's id
 * and goes through its scope.
 */
export class WebhookDeliveriesService {
  constructor(
    private readonly collection: TypedCollection<typeof webhookDeliveries>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private scoped(tenantId: string) {
    return scopeToTenant(this.collection, new ObjectId(tenantId));
  }

  /** Stores one attempt, then drops the endpoint's attempts past the newest 100. */
  async record(tenantId: string, attempt: AttemptRecord): Promise<void> {
    const scoped = this.scoped(tenantId);
    await scoped.create({
      endpointId: attempt.endpointId,
      eventId: attempt.eventId,
      type: attempt.type,
      attempt: attempt.attempt,
      status: attempt.status,
      error: attempt.error,
      durationMs: Math.max(0, Math.round(attempt.durationMs)),
      delivered: attempt.delivered,
      willRetry: attempt.willRetry,
      at: this.now(),
    });
    const filter = { endpointId: attempt.endpointId };
    if ((await scoped.count(filter)) <= DELIVERIES_PER_ENDPOINT) return;
    const newest = await scoped.findMany({
      filter,
      sort: { _id: -1 },
      limit: DELIVERIES_PER_ENDPOINT,
    });
    const oldestKept = newest.at(-1);
    if (oldestKept === undefined) return;
    await scoped.deleteMany({ ...filter, _id: { $lt: oldestKept._id } });
  }

  /** The endpoint's attempts, newest first. */
  async list(
    tenantId: string,
    endpointId: string,
    limit = MAX_LISTED,
  ): Promise<WebhookDeliveryDoc[]> {
    return this.scoped(tenantId).findMany({
      filter: { endpointId },
      sort: { _id: -1 },
      limit: Math.min(Math.max(limit, 1), MAX_LISTED),
    });
  }

  /** An endpoint was deleted: its attempts go with it. */
  async deleteForEndpoint(tenantId: string, endpointId: string): Promise<void> {
    await this.scoped(tenantId).deleteMany({ endpointId });
  }
}
