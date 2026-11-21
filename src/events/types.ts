import type {
  AuthEventType,
  AuthMethod,
  AuthOutcome,
} from "@/modules/audit/audit.model";
import type { ClavixWebhookEvent } from "@/modules/webhooks";

/** One thing a tenant's user did to their access, as a source reports it. */
export interface AuthEvent {
  kind: "auth";
  /** The tenant's hex id. */
  tenantId: string;
  type: AuthEventType;
  outcome: AuthOutcome;
  reason?: string | undefined;
  method?: AuthMethod | undefined;
  /** The user it is about; absent for a failed sign-in that names none. */
  userId?: string | undefined;
  clientId?: string | undefined;
  /** The client address, kept in the sign-in log only (D15). */
  ip?: string | undefined;
  /** The raw User-Agent header; only its family is stored. */
  userAgent?: string | undefined;
  requestId?: string | undefined;
  at?: Date | undefined;
}

/**
 * An event that webhooks deliver (M4 W1, D22): already in the Standard
 * Webhooks shape, with ids only in `data`. A source emits it for every janus
 * user event, and the webhook relay subscribes to it.
 */
export interface WebhookSourceEvent {
  kind: "webhook";
  /** The tenant's hex id; the same as `event.data.tenantId`. */
  tenantId: string;
  event: ClavixWebhookEvent;
}

/** What the Clavix event bus carries. Telemetry subscribes to the same union later. */
export type ClavixEvent = AuthEvent | WebhookSourceEvent;
