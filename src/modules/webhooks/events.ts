import type { UserEvent, UserEventType } from "@softistx/janus";
import type { WebhookEvent } from "@softistx/janus-webhooks";
import type { AuthEvent } from "@/events/types";

// The event catalogue of the webhooks (D22): the 18 user events of janus that
// Clavix can emit and its `session.signedIn`. `user.apiKeyCreated` and
// `user.apiKeyRevoked` are left out: Clavix configures no janus `apiKeys`, so
// they can never fire (#336); they come back with API keys. Typed as a record
// so that a type janus adds fails the build here, where the catalogue is decided.
type NotEmitted = "user.apiKeyCreated" | "user.apiKeyRevoked";
const USER_TYPES: Record<Exclude<UserEventType, NotEmitted>, true> = {
  "user.created": true,
  "user.emailVerified": true,
  "user.passwordReset": true,
  "user.passwordChanged": true,
  "user.emailChanged": true,
  "user.secondFactorEnabled": true,
  "user.secondFactorDisabled": true,
  "user.recoveryCodesRegenerated": true,
  "user.recoveryCodeUsed": true,
  "user.newDeviceSignedIn": true,
  "user.avatarChanged": true,
  "user.avatarRemoved": true,
  "user.socialLinked": true,
  "user.socialUnlinked": true,
  "user.passkeyAdded": true,
  "user.passkeyRemoved": true,
  "user.passkeyCloneSuspected": true,
  "user.deleted": true,
};

export const WEBHOOK_EVENT_TYPES: readonly string[] = [
  ...Object.keys(USER_TYPES),
  "session.signedIn",
];

export const isWebhookEventType = (value: string): boolean =>
  WEBHOOK_EVENT_TYPES.includes(value);

/**
 * What a webhook carries in `data` (D15, D22): identifiers only, never an
 * address, an e-mail or a name. `tenantId` is there because janus-webhooks
 * puts only `type`, `timestamp` and `data` on the wire: it is how a receiver
 * (and the resolver) knows whose event it is.
 */
export type WebhookData = {
  tenantId: string;
  userId?: string;
  userType?: string;
  /** On the two social events: the application's name for the provider. */
  provider?: string;
  /** On `webhook.test` only: the one endpoint the test goes to. */
  endpointId?: string;
};

export type ClavixWebhookEvent = WebhookEvent<string, WebhookData>;

/** A janus user event as a webhook event of the tenant, with ids only. */
export function userWebhookEvent(
  tenantId: string,
  event: UserEvent,
): ClavixWebhookEvent {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    data: {
      tenantId,
      userId: event.userId,
      userType: event.userType,
      ...(event.provider === undefined ? {} : { provider: event.provider }),
    },
  };
}

/** A successful sign-in of the sign-in log as `session.signedIn`; anything else is not delivered. */
export function signedInWebhookEvent(
  event: AuthEvent,
): ClavixWebhookEvent | undefined {
  if (
    event.type !== "session.signIn" ||
    event.outcome !== "success" ||
    event.userId === undefined
  ) {
    return undefined;
  }
  return {
    id: crypto.randomUUID(),
    type: "session.signedIn",
    occurredAt: event.at ?? new Date(),
    data: { tenantId: event.tenantId, userId: event.userId },
  };
}
