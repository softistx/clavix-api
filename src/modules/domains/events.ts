import type { ObjectId } from "mongodb";
import type { AdminEventInput } from "@/console/admin-events/recorder";

/**
 * What the platform itself does to a claim, with no console user behind it:
 * the recheck lapsing a verified domain, a verification evicting the other
 * tenants' claims on the host.
 */
export interface DomainSystemEvent {
  action: "domain.lapse" | "domain.evict";
  /** The tenant the claim belonged to. */
  tenantId: ObjectId;
  /** The claim's id. */
  domainId: ObjectId;
}

// Like the CLI's `cli:operators:grant`: a system actor is `system:<module>:<job>`,
// not the id of a user.
const ACTOR: Record<DomainSystemEvent["action"], string> = {
  "domain.lapse": "system:domains:recheck",
  "domain.evict": "system:domains:verify",
};

/** The admin event of a system event: identifiers only, a request id of its own. */
export const domainEventInput = (
  event: DomainSystemEvent,
): AdminEventInput => ({
  actor: ACTOR[event.action],
  action: event.action,
  tenantId: event.tenantId.toHexString(),
  target: { type: "domain", id: event.domainId.toHexString() },
  requestId: crypto.randomUUID(),
});
