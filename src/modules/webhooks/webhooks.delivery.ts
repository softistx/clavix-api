import type { Duration } from "@softistx/janus";
import {
  type Attempt,
  type Delivery,
  type EndpointResolver,
  type GivingUp,
  type WebhookQueue,
  webhooks,
} from "@softistx/janus-webhooks";
import type { ClavixEvent } from "@/events/types";
import type { ClavixWebhookEvent } from "./webhooks.events";
import { TEST_EVENT_TYPE } from "./webhooks.rules";
import type { WebhooksService } from "./webhooks.service";
import {
  attemptRecordOf,
  endpointIdOf,
  queuedEndpoints,
  relayedEventOf,
  testEventOf,
} from "./webhooks.utils";

export interface DisabledEndpoint {
  tenantId: string;
  endpointId: string;
}

export interface DeliveryDeps {
  /** The current time (stamps `occurredAt`). */
  now: () => Date;
  /** The endpoints, and where each attempt is logged (W2). */
  webhooks: WebhooksService;
  /** The guarded `fetch` (D21): checks the address on every send. */
  fetch: typeof fetch;
  /** The shared queue (Redis, or the in-memory one bound in config). */
  queue: WebhookQueue;
  /** Default: the Standard Webhooks schedule. */
  retries?: readonly Duration[];
  /** Default 10 s (D20). */
  timeout?: Duration;
  poll?: Duration;
  /** An endpoint was switched off after `GIVE_UP_LIMIT` given-up deliveries in a row. */
  onDisabled(endpoint: DisabledEndpoint): Promise<void>;
  log: (message: string) => void;
}

type Log = (message: string) => void;

/** The tenant's endpoints for one event, queue-named. */
function endpointResolver(
  deps: DeliveryDeps,
): EndpointResolver<ClavixWebhookEvent> {
  return async (event) =>
    queuedEndpoints(
      event,
      await deps.webhooks.deliveryEndpoints(event.data.tenantId),
    );
}

/**
 * The attempt log keeps what the receiver answered, never the URL or a body; a
 * failure to write it must not touch the delivery.
 */
function attemptHandler(
  deps: DeliveryDeps,
  log: Log,
): (attempt: Attempt<ClavixWebhookEvent>) => Promise<void> {
  return async (attempt) => {
    const tenantId = attempt.event.data.tenantId;
    const record = attemptRecordOf(attempt);
    try {
      await deps.webhooks.recordAttempt(tenantId, record);
    } catch (error) {
      log(`webhooks: could not log an attempt: ${String(error)}`);
    }
    if (!attempt.delivered) return;
    try {
      await deps.webhooks.recordDelivered(tenantId, record.endpointId);
    } catch (error) {
      log(`webhooks: could not record a delivery: ${String(error)}`);
    }
  };
}

/** A delivery given up counts against its endpoint; the one that switches it off tells `onDisabled`. */
function giveUpHandler(
  deps: DeliveryDeps,
  log: Log,
): (delivery: Delivery<ClavixWebhookEvent>, reason: GivingUp) => Promise<void> {
  return async (delivery, reason) => {
    // `closed` and `endpointRemoved` say nothing about the receiver.
    if (reason.why !== "retriesRanOut") return;
    if (delivery.event.type === TEST_EVENT_TYPE) return;
    const tenantId = delivery.event.data.tenantId;
    const endpointId = endpointIdOf(delivery.endpoint);
    try {
      if (await deps.webhooks.recordGiveUp(tenantId, endpointId)) {
        await deps.onDisabled({ tenantId, endpointId });
      }
    } catch (error) {
      log(`webhooks: could not record a given-up delivery: ${String(error)}`);
    }
  };
}

/** The `webhooks()` listener every tenant's events go through. */
function deliveryListener(deps: DeliveryDeps) {
  return webhooks<ClavixWebhookEvent>({
    endpoints: endpointResolver(deps),
    fetch: deps.fetch,
    queue: deps.queue,
    ...(deps.retries === undefined ? {} : { retries: deps.retries }),
    ...(deps.timeout === undefined ? {} : { timeout: deps.timeout }),
    ...(deps.poll === undefined ? {} : { poll: deps.poll }),
    onAttempt: attemptHandler(deps, deps.log),
    onGivingUp: giveUpHandler(deps, deps.log),
  });
}

/**
 * The process-wide delivery (D20): one `webhooks()` for every tenant, whose
 * endpoints are read at send time and at each attempt from the tenant the
 * event names, so a rolled secret or a switched-off endpoint is honoured by a
 * retry. It is fed by the event bus (`relay`) and by `sendTest`.
 */
export function createWebhookDelivery(deps: DeliveryDeps) {
  const listener = deliveryListener(deps);
  return {
    /** The event bus subscriber: a failure rejects, and the bus swallows it (D13). */
    relay: async (event: ClavixEvent): Promise<void> => {
      const relayed = relayedEventOf(event, deps.now);
      if (relayed !== undefined) await listener(relayed);
    },
    /** Sends a `webhook.test` event to this one endpoint; its event id. */
    async sendTest(tenantId: string, endpointId: string): Promise<string> {
      const event = testEventOf(tenantId, endpointId, deps.now());
      await listener(event);
      return event.id;
    },
    /** On shutdown: waits for the requests in flight; what waits in Redis is sent by the next process. */
    close: () => listener.close(),
  };
}

export type WebhookDelivery = ReturnType<typeof createWebhookDelivery>;
