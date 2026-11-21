import type { ReadDocumentOf } from "@softistx/mongo";
import type { webhookDeliveries, webhookEndpoints } from "./webhooks.model";
import type { UrlPolicy } from "./webhooks.url-policy";

export type WebhookEndpointDoc = ReadDocumentOf<typeof webhookEndpoints>;
export type WebhookDeliveryDoc = ReadDocumentOf<typeof webhookDeliveries>;

/** What `webhooks()` gets for one endpoint (its `WebhookEndpoint`, with the secrets opened). */
export interface DeliveryEndpoint {
  id: string;
  url: string;
  secrets: [string, ...string[]];
  types?: string[];
  disabled: boolean;
}

export interface EndpointInput {
  url: string;
  description?: string | undefined;
  types?: readonly string[] | undefined;
}

export interface EndpointPatch {
  url?: string | undefined;
  description?: string | undefined;
  types?: readonly string[] | undefined;
  enabled?: boolean | undefined;
}

/** The fields an update writes: only what changed. */
export interface EndpointChanges {
  url?: string;
  description?: string;
  types?: string[];
  enabled?: boolean;
  disabledReason?: "givenUp" | "manual" | null;
  consecutiveGiveUps?: number;
}

export interface WebhooksServiceOptions {
  policy: UrlPolicy;
  now: () => Date;
  /** Mints a `whsec_` secret; a spec fixes it. */
  mint: () => string;
  log: (message: string) => void;
}

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
