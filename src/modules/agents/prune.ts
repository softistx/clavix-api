import type { AgentPruneEvent } from "./prune-events";

/** An agent that registered itself and has no standing grant after this long is deleted (D10). */
export const AGENT_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneDeps {
  /** The ids (hex) of the tenants whose agents are pruned. */
  tenantIds(): Promise<string[]>;
  /** The tenant's dynamically registered agents recorded before `before`. */
  candidates(tenantId: string, before: Date): Promise<string[]>;
  /** Whether a user still holds a standing (not revoked) grant of the client. */
  hasStandingGrant(tenantId: string, clientId: string): Promise<boolean>;
  /** Deletes the client, its grants and tokens, its rules and its agent record. */
  remove(tenantId: string, clientId: string): Promise<unknown>;
  /** The admin event of one deleted agent. */
  emit(event: AgentPruneEvent): Promise<void>;
  log?: (message: string) => void;
}

export interface PruneReport {
  /** How many agents were deleted. */
  pruned: number;
  /** How many agents (or tenants) a pass could not finish; the next run takes them again. */
  failed: number;
}

/**
 * The daily clean-up (M3, D10): every dynamically registered agent that has
 * no standing grant 7 days after it registered is deleted, with its tokens
 * closed. Agents of a metadata document are not touched (janus caches them and
 * lets them lapse). Each agent is its own step: one that fails is logged and
 * counted, the others go on, and the next run takes it again. Deleting is
 * idempotent, so two instances running the same pass do no harm. A failure to
 * record the admin event is logged, never undoes the deletion.
 */
export async function pruneAgents(
  deps: PruneDeps,
  now: Date = new Date(),
): Promise<PruneReport> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const before = new Date(now.getTime() - AGENT_GRACE_DAYS * DAY_MS);
  const report: PruneReport = { pruned: 0, failed: 0 };
  for (const tenantId of await deps.tenantIds()) {
    let ids: string[];
    try {
      ids = await deps.candidates(tenantId, before);
    } catch (error) {
      report.failed += 1;
      log(`agents: could not list the agents of ${tenantId}: ${String(error)}`);
      continue;
    }
    for (const clientId of ids) {
      try {
        if (await deps.hasStandingGrant(tenantId, clientId)) continue;
        await deps.remove(tenantId, clientId);
        report.pruned += 1;
      } catch (error) {
        report.failed += 1;
        log(
          `agents: could not prune ${clientId} of ${tenantId}: ${String(error)}`,
        );
        continue;
      }
      await deps.emit({ tenantId, clientId }).catch((error: unknown) => {
        log(
          `agents: no admin event for ${clientId} of ${tenantId}: ${String(error)}`,
        );
      });
    }
  }
  return report;
}
