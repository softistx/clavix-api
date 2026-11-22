import type { AgentPruneEvent } from "./agents.prune-events";

/** An agent (registered or described by a metadata document) that has no standing grant after this long is deleted (D10). */
export const AGENT_GRACE_DAYS = 7;
/** An agent that never got a grant (never used) is deleted after this shorter time, so open registration cannot hold the `agents` quota for 7 days. */
export const AGENT_UNUSED_GRACE_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What the OAuth store holds of an agent: a standing grant, only revoked ones, or no grant ever (never used). */
export type GrantState = "standing" | "revoked" | "none";

export interface PruneDeps {
  /** The ids (hex) of the tenants whose agents are pruned. */
  tenantIds(): Promise<string[]>;
  /** The tenant's agents (any kind) recorded before `before`, oldest first. */
  candidates(tenantId: string, before: Date): Promise<string[]>;
  /** Whether a user holds a standing (not revoked) grant of the client, only revoked ones, or none ever. */
  grantState(tenantId: string, clientId: string): Promise<GrantState>;
  /**
   * Deletes the client, its grants and tokens, its rules and its agent
   * record; `false` when it was already gone (nothing removed, no event).
   */
  remove(tenantId: string, clientId: string): Promise<boolean>;
  /**
   * Runs the grant check and the delete of one agent alone for the tenant
   * (the console's clients lock), serialized with the console's client writes.
   * Consent approval does not take it: a grant made between the two is revoked
   * with the agent (a very small window).
   */
  locked<T>(tenantId: string, work: () => Promise<T>): Promise<T>;
  /** The admin event of one deleted agent. */
  emit(event: AgentPruneEvent): Promise<void>;
  log: (message: string) => void;
}

export interface PruneReport {
  /** How many agents were deleted. */
  pruned: number;
  /** How many agents (or tenants) a pass could not finish; the next run takes them again. */
  failed: number;
}

/**
 * The daily clean-up (M3, D10): every agent that has
 * no standing grant 7 days after it was recorded is deleted, with its tokens
 * closed; an agent that never had a grant (never used) goes after 24 hours. A metadata-document agent is one too: it is fetched and recorded
 * again at its next use, and meanwhile it must not count toward the quota.
 * The grant check and the delete run under one lock. Each agent is its own step: one that fails is logged and
 * counted, the others go on, and the next run takes it again. Deleting is
 * idempotent, so two instances running the same pass do no harm. A failure to
 * record the admin event is logged, never undoes the deletion.
 */
export async function pruneAgents(
  deps: PruneDeps,
  now: Date,
): Promise<PruneReport> {
  const log = deps.log;
  const before = new Date(now.getTime() - AGENT_GRACE_DAYS * DAY_MS);
  const unusedBefore = new Date(
    now.getTime() - AGENT_UNUSED_GRACE_HOURS * HOUR_MS,
  );
  const report: PruneReport = { pruned: 0, failed: 0 };
  for (const tenantId of await deps.tenantIds()) {
    let ids: string[];
    let old: Set<string>;
    try {
      ids = await deps.candidates(tenantId, unusedBefore);
      old = new Set(await deps.candidates(tenantId, before));
    } catch (error) {
      report.failed += 1;
      log(`agents: could not list the agents of ${tenantId}: ${String(error)}`);
      continue;
    }
    for (const clientId of ids) {
      try {
        const run = deps.locked.bind(deps);
        const removed = await run(tenantId, async () => {
          const state = await deps.grantState(tenantId, clientId);
          if (state === "standing") return false;
          // A used agent (a grant, now revoked) keeps the 7 days; an unused one only the 24 hours.
          if (state === "revoked" && !old.has(clientId)) return false;
          return deps.remove(tenantId, clientId);
        });
        if (!removed) continue;
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
