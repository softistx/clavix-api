import type { Duration } from "@softistx/janus";
import {
  type EndpointResolver,
  type WebhookQueue,
  webhooks,
} from "@softistx/janus-webhooks";
import type { ClavixEvent } from "@/events/types";
import {
  type ClavixWebhookEvent,
  signedInWebhookEvent,
  type WebhookData,
} from "./events";
import type { WebhookEndpointsService } from "./webhook-endpoints.service";

/** The type of the event `sendTestWebhook` sends: not in the catalogue, never subscribed to. */
export const TEST_EVENT_TYPE = "webhook.test";

/** The actor of the admin event the auto-disable records (D20). */
export const DISABLE_ACTOR = "system:webhooks:disable";

export interface DisabledEndpoint {
  tenantId: string;
  endpointId: string;
}

export interface DeliveryDeps {
  endpoints: WebhookEndpointsService;
  /** The guarded `fetch` (D21): checks the address on every send. */
  fetch: typeof fetch;
  /** The shared queue (Redis); in memory when absent. */
  queue?: WebhookQueue;
  /** Default: the Standard Webhooks schedule. */
  retries?: readonly Duration[];
  /** Default 10 s (D20). */
  timeout?: Duration;
  poll?: Duration;
  /** An endpoint was switched off after `GIVE_UP_LIMIT` given-up deliveries in a row. */
  onDisabled(endpoint: DisabledEndpoint): Promise<void>;
  log?: (message: string) => void;
}

/**
 * The process-wide delivery (D20): one `webhooks()` for every tenant, whose
 * endpoints are read at send time and at each attempt from the tenant the
 * event names, so a rolled secret or a switched-off endpoint is honoured by a
 * retry. It is fed by the event bus (`relay`) and by `sendTest`.
 */
export function createWebhookDelivery(deps: DeliveryDeps) {
  const log = deps.log ?? ((message: string) => console.warn(message));

  const endpoints: EndpointResolver<ClavixWebhookEvent> = async (event) => {
    const all = await deps.endpoints.deliveryEndpoints(event.data.tenantId);
    if (event.type === TEST_EVENT_TYPE) {
      return all
        .filter((endpoint) => endpoint.id === event.data.endpointId)
        .map(({ types: _types, ...endpoint }) => endpoint);
    }
    return all;
  };

  const listener = webhooks<ClavixWebhookEvent>({
    endpoints,
    fetch: deps.fetch,
    ...(deps.queue === undefined ? {} : { queue: deps.queue }),
    ...(deps.retries === undefined ? {} : { retries: deps.retries }),
    ...(deps.timeout === undefined ? {} : { timeout: deps.timeout }),
    ...(deps.poll === undefined ? {} : { poll: deps.poll }),
    onAttempt: async (attempt) => {
      if (!attempt.delivered) return;
      try {
        await deps.endpoints.recordDelivered(
          attempt.event.data.tenantId,
          attempt.endpoint,
        );
      } catch (error) {
        log(`webhooks: could not record a delivery: ${String(error)}`);
      }
    },
    onGivingUp: async (delivery, reason) => {
      // `closed` and `endpointRemoved` say nothing about the receiver.
      if (reason.why !== "retriesRanOut") return;
      if (delivery.event.type === TEST_EVENT_TYPE) return;
      const tenantId = delivery.event.data.tenantId;
      try {
        const disabled = await deps.endpoints.recordGiveUp(
          tenantId,
          delivery.endpoint,
        );
        if (disabled) {
          await deps.onDisabled({ tenantId, endpointId: delivery.endpoint });
        }
      } catch (error) {
        log(`webhooks: could not record a given-up delivery: ${String(error)}`);
      }
    },
  });

  return {
    /** The event bus subscriber: a failure rejects, and the bus swallows it (D13). */
    relay: async (event: ClavixEvent): Promise<void> => {
      if (event.kind === "webhook") await listener(event.event);
      else if (event.kind === "auth") {
        const signedIn = signedInWebhookEvent(event);
        if (signedIn !== undefined) await listener(signedIn);
      }
    },
    /** Sends a `webhook.test` event to this one endpoint; its event id. */
    async sendTest(tenantId: string, endpointId: string): Promise<string> {
      const data: WebhookData = { tenantId, endpointId };
      const event: ClavixWebhookEvent = {
        id: crypto.randomUUID(),
        type: TEST_EVENT_TYPE,
        occurredAt: new Date(),
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
