import type {
  AuthEventType,
  AuthMethod,
  AuthOutcome,
} from "@/modules/audit/auth-events.model";

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

/** What the Clavix event bus carries. Webhooks and telemetry subscribe to the same union later. */
export type ClavixEvent = AuthEvent;
