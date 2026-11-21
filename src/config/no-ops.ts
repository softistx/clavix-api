import type { ExportThrottle } from "@/console/audit-export/throttle";
import type { ConsoleBudgets } from "@/console/budgets";
import type { Throttle, UserThrottle } from "@/http/throttle/core";
import type { ClientDetailTypes } from "@/modules/resources";
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

/** The TLS ask's limit without Redis (development, specs): every ask is within it. */
export const unlimited = async (): Promise<boolean> => true;

/** A per-address and per-tenant throttle without Redis (development, specs): no extra limit. */
export const noThrottle: Throttle = { check: async () => {} };

/** A per-user throttle without Redis (development, specs): no extra limit. */
export const noUserThrottle: UserThrottle = { check: async () => {} };

/** A tenant that lists no detail types (the console's own client): none stored. */
export const noDetailTypes: ClientDetailTypes = {
  namesOf: async () => new Set<string>(),
};

/** The console's budgets without Redis (development, specs): every call is within them. */
export const noBudgets: ConsoleBudgets = {
  testWebhook: async () => {},
  invitation: async () => {},
  inviteCaller: { consume: async () => ({ allowed: true, retryAfter: 0 }) },
};

/** A background queue without Redis (development): its worker never ticks, only the pass at start runs. */
export const noQueue = {
  work: () => ({ on: () => {} }),
};

/** The per-user lock of a script or a spec that runs nothing beside it: the work runs at once. */
export const noUserLock = <T>(_userId: string, work: () => Promise<T>) =>
  work();
