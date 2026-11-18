import type { UserEvent, UserEventListener } from "@softistx/janus";
import type { AuthEventType } from "@/modules/audit/auth-events.model";
import { userWebhookEvent } from "@/modules/webhooks/events";
import type { EventBus } from "./bus";

// The janus user events the sign-in log keeps (D14): second-factor and passkey
// changes. The rest (created, e-mail changed, avatar...) is not an access event.
const TYPES: Partial<Record<UserEvent["type"], AuthEventType>> = {
  "user.secondFactorEnabled": "secondFactor.enabled",
  "user.secondFactorDisabled": "secondFactor.disabled",
  "user.recoveryCodesRegenerated": "recoveryCodes.regenerated",
  "user.recoveryCodeUsed": "recoveryCode.used",
  "user.passkeyAdded": "passkey.added",
  "user.passkeyRemoved": "passkey.removed",
  "user.passkeyCloneSuspected": "passkey.cloneSuspected",
};

/**
 * janus's `events` listener of one tenant: every event goes to the bus as a
 * webhook candidate (D22), and the events of D14 as auth events,
 * tagged with the tenant the instance belongs to (so one tenant's instance can
 * never write into another's log). A janus event carries no address.
 */
export const janusListener =
  (tenantId: string, bus: Pick<EventBus, "emit">): UserEventListener =>
  async (event) => {
    // Every user event is a candidate webhook (D22), ids only.
    await bus.emit({
      kind: "webhook",
      tenantId,
      event: userWebhookEvent(tenantId, event),
    });
    const type = TYPES[event.type];
    if (type === undefined) return;
    await bus.emit({
      kind: "auth",
      tenantId,
      type,
      outcome:
        event.type === "user.passkeyCloneSuspected" ? "failure" : "success",
      ...(event.type === "user.passkeyCloneSuspected"
        ? { reason: "counterRegression" }
        : {}),
      userId: event.userId,
      at: event.occurredAt,
    });
  };
