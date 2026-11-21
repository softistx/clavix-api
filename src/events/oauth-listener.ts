import type { OAuthEvent, OAuthEventListener } from "@softistx/janus-oauth";
import type { AuthEventType } from "@/modules/audit";
import type { EventBus } from "./bus";
import type { AuthEvent } from "./types";

const MAX_REASON = 100;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_REASON)
    : undefined;

type Mapped = Pick<AuthEvent, "type" | "outcome" | "reason">;

// The janus-oauth events the sign-in log keeps (D14). `oauth.client.loginFailed`
// is not one (a client's wrong secret is telemetry's), and per-token events do
// not exist in janus. A refusal or a denial is a `failure`, a reason a code.
const mapped = (event: OAuthEvent): Mapped | undefined => {
  const d = event.data;
  const keep = (
    type: AuthEventType,
    outcome: AuthEvent["outcome"],
    reason: unknown,
  ): Mapped => ({ type, outcome, reason: text(reason) });
  switch (event.type) {
    case "oauth.grant.created":
      return keep("consent.granted", "success", d["via"]);
    case "oauth.request.denied":
      return keep("consent.denied", "failure", "denied");
    case "oauth.grant.revoked":
      return keep("grant.revoked", "success", d["reason"]);
    case "oauth.refresh.reused":
      return keep("refreshToken.reused", "failure", "reused");
    case "oauth.device.decided":
      return d["decision"] === "approved"
        ? keep("device.approved", "success", "approved")
        : keep("device.denied", "failure", "denied");
    case "oauth.token.exchanged":
      return keep("token.exchanged", "success", d["mode"]);
    case "oauth.client.registered":
      return keep("client.registered", "success", d["via"]);
    default:
      return undefined;
  }
};

/**
 * janus-oauth's `events` listener of one tenant's issuer: the events of D14 go
 * to the bus, tagged with the tenant the issuer was built for, so one tenant's
 * issuer can never write into another's log. An event that names another
 * issuer is dropped. It carries ids and codes only, no address (D15), no
 * client name (text the client supplied) and no token.
 */
export const oauthListener =
  (
    tenantId: string,
    issuer: string,
    bus: Pick<EventBus, "emit">,
  ): OAuthEventListener =>
  async (event) => {
    if (event.issuer !== issuer) return;
    const kept = mapped(event);
    if (kept === undefined) return;
    await bus.emit({
      kind: "auth",
      tenantId,
      type: kept.type,
      outcome: kept.outcome,
      ...(kept.reason === undefined ? {} : { reason: kept.reason }),
      ...(event.userId === undefined ? {} : { userId: event.userId }),
      ...(event.clientId === undefined ? {} : { clientId: event.clientId }),
      requestId: event.id,
      at: event.occurredAt,
    });
  };
