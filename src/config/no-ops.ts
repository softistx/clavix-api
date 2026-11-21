import type { ExportThrottle } from "@/console/audit-export/throttle";
import type { InvitationHooks } from "@/modules/users";

/**
 * The named no-ops of the one-way callbacks that have no consumer here: bound
 * once, in the wiring, never defaulted inside a service (AGENTS.md: ports are
 * required and bound in `src/config/*`).
 */

/** The invitation hooks of a tenant that has none: every acceptance is allowed, nothing runs after it. */
export const noInvitationHooks: InvitationHooks = {
  beforeAccept: () => true,
  onAccepted: () => {},
};

/** The audit export's budget without Redis (development, specs): every export is within it. */
export const unthrottled: ExportThrottle = async () => null;
