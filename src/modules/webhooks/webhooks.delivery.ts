import type { Duration } from "@softistx/janus";
import {
  type Attempt,
  type Delivery,
  type EndpointResolver,
  type GivingUp,
  type RefusedDelivery,
  type WebhookQueue,
  type WebhookQueueLimits,
  webhooks,
} from "@softistx/janus-webhooks";
import type { ClavixEvent } from "@/events/types";
import {
  type ClavixWebhookEvent,
  signedInWebhookEvent,
  type WebhookData,
} from "./webhooks.events";
import type { WebhooksService } from "./webhooks.service";

/** The type of the event `sendTestWebhook` sends: not in the catalogue, never subscribed to. */
export const TEST_EVENT_TYPE = "webhook.test";

/**
 * The queue's name for an endpoint: `<tenantId>.<endpointId>` (both hex ids,
 * no dot). The queue caps what one *group* holds (`webhookGroupOf`), so the
 * tenant must be readable from the name, in every process.
 */
export const queueEndpointId = (tenantId: string, endpointId: string) =>
  `${tenantId}.${endpointId}`;

/** The queue's group of an endpoint: its tenant. A name with no dot (a delivery queued before the prefix) is its own group. */
export const webhookGroupOf = (queueEndpoint: string) =>
  queueEndpoint.split(".")[0] ?? queueEndpoint;

/** The endpoint's own id out of the queue's name. */
export const endpointIdOf = (queueEndpoint: string) => {
  const dot = queueEndpoint.indexOf(".");
  return dot === -1 ? queueEndpoint : queueEndpoint.slice(dot + 1);
};

/**
 * The queue's caps (G2-03), per tenant (`webhookGroupOf`): a tenant whose
 * endpoint floods, or answers slowly, holds at most `maxInFlight` requests in
 * flight and `maxPending` deliveries; the other tenants' endpoints are claimed
 * all the same. Every process passes the same ones. A refused delivery is
 * reported by ids only (never a URL or a body).
 */
export const webhookQueueLimits = (
  caps: { maxInFlight: number; maxPending: number },
  log: (message: string) => void,
): WebhookQueueLimits => ({
  ...caps,
  groupOf: webhookGroupOf,
  onRefused: ({ event, group, maxPending }: RefusedDelivery) =>
    log(
      `webhooks: delivery ${event.id} refused, tenant ${group ?? "?"} holds ${maxPending}`,
    ),
});

/** The actor of the admin event the auto-disable records (D20). */
export const DISABLE_ACTOR = "system:webhooks:disable";

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

/** The tenant's endpoints for one event, queue-named; a test event reaches its one endpoint, whatever its types. */
function endpointResolver(
  deps: DeliveryDeps,
): EndpointResolver<ClavixWebhookEvent> {
  return async (event) => {
    const all = await deps.webhooks.deliveryEndpoints(event.data.tenantId);
    const tenantId = event.data.tenantId;
    const named = (list: typeof all) =>
      list.map((endpoint) => ({
        ...endpoint,
        id: queueEndpointId(tenantId, endpoint.id),
      }));
    if (event.type === TEST_EVENT_TYPE) {
      return named(
        all
          .filter((endpoint) => endpoint.id === event.data.endpointId)
          .map(({ types: _types, ...endpoint }) => endpoint),
      );
    }
    return named(all);
  };
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
    try {
      await deps.webhooks.recordAttempt(tenantId, {
        endpointId: endpointIdOf(attempt.endpoint),
        eventId: attempt.event.id,
        type: attempt.event.type,
        attempt: attempt.attempt,
        status: attempt.status,
        error: attempt.error,
        durationMs: attempt.durationMs,
        delivered: attempt.delivered,
        willRetry: attempt.willRetry,
      });
    } catch (error) {
      log(`webhooks: could not log an attempt: ${String(error)}`);
    }
    if (!attempt.delivered) return;
    try {
      await deps.webhooks.recordDelivered(
        tenantId,
        endpointIdOf(attempt.endpoint),
      );
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

/**
 * The process-wide delivery (D20): one `webhooks()` for every tenant, whose
 * endpoints are read at send time and at each attempt from the tenant the
 * event names, so a rolled secret or a switched-off endpoint is honoured by a
 * retry. It is fed by the event bus (`relay`) and by `sendTest`.
 */
export function createWebhookDelivery(deps: DeliveryDeps) {
  const log = deps.log;
  const listener = webhooks<ClavixWebhookEvent>({
    endpoints: endpointResolver(deps),
    fetch: deps.fetch,
    queue: deps.queue,
    ...(deps.retries === undefined ? {} : { retries: deps.retries }),
    ...(deps.timeout === undefined ? {} : { timeout: deps.timeout }),
    ...(deps.poll === undefined ? {} : { poll: deps.poll }),
    onAttempt: attemptHandler(deps, log),
    onGivingUp: giveUpHandler(deps, log),
  });

  return {
    /** The event bus subscriber: a failure rejects, and the bus swallows it (D13). */
    relay: async (event: ClavixEvent): Promise<void> => {
      if (event.kind === "webhook") await listener(event.event);
      else if (event.kind === "auth") {
        const signedIn = signedInWebhookEvent(event, deps.now);
        if (signedIn !== undefined) await listener(signedIn);
      }
    },
    /** Sends a `webhook.test` event to this one endpoint; its event id. */
    async sendTest(tenantId: string, endpointId: string): Promise<string> {
      const data: WebhookData = { tenantId, endpointId };
      const event: ClavixWebhookEvent = {
        id: crypto.randomUUID(),
        type: TEST_EVENT_TYPE,
        occurredAt: deps.now(),
        data,
      };
      await listener(event);
      return event.id;
    },
    /** On shutdown: waits for the requests in flight; what waits in Redis is sent by the next process. */
    close: () => listener.close(),
  };
}

export type WebhookDelivery = ReturnType<typeof createWebhookDelivery>;
