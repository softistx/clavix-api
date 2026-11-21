import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { ObjectId } from "mongodb";
import { type PruneReport, pruneAgents } from "@/modules/agents/agents.prune";
import { agentPruneEventInput } from "@/modules/agents/agents.prune-events";
import { clientsKey } from "@/modules/clients";
import { partitionOf } from "@/modules/tenants";
import { adminEventRecorder } from "./admin-events";
import { agentClientsService } from "./agent-clients";
import { clientsService } from "./clients";
import { exclusive } from "./exclusive";
import { oauthDb } from "./oauth-db";
import { warn } from "./runtime";
import { tenantsService } from "./tenancy";

const PAGE = 100;

/** Whether any grant of the client stands (is not revoked), read page by page in the tenant's partition. */
async function hasStandingGrant(tenantId: string, clientId: string) {
  const store = createMongoOAuth(oauthDb, {
    partition: partitionOf(new ObjectId(tenantId)),
  });
  if (store.listClientGrants === undefined) {
    throw new Error("the OAuth store has no listClientGrants()");
  }
  let cursor: string | undefined;
  do {
    const page = await store.listClientGrants(clientId, {
      cursor,
      limit: PAGE,
    });
    if (page.items.some((grant) => grant.revokedAt === null)) return true;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return false;
}

/**
 * The daily clean-up of the unused agents over the real stores (D10). The
 * deletion is the console's (`clientsService.delete`: the client, its grants
 * and tokens, its rules and its agent record).
 */
export const createAgentsPrune =
  (now: () => Date) => (): Promise<PruneReport> =>
    pruneAgents(
      {
        tenantIds: () => tenantsService.activeIds(),
        candidates: (tenantId, before) =>
          agentClientsService.registeredBefore(tenantId, before),
        hasStandingGrant,
        // The console's clients lock: serializes the check and the delete with console client writes
        // (consent approval does not take it, so a grant made in between is revoked with the agent).
        locked: (tenantId, work) =>
          exclusive(clientsKey({ _id: new ObjectId(tenantId) }), work),
        remove: async (tenantId, clientId) =>
          (
            await clientsService.delete(
              { _id: new ObjectId(tenantId), slug: "", status: "active" },
              clientId,
            )
          ).removed,
        emit: (event) => adminEventRecorder.record(agentPruneEventInput(event)),
        log: warn,
      },
      now(),
    );
