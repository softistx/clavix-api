import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { ObjectId } from "mongodb";
import {
  agentPruneEventInput,
  type GrantState,
  type PruneReport,
  pruneAgents,
} from "@/modules/agents";
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

/** Whether a grant of the client stands, only revoked ones exist, or none ever did (never used); read page by page in the tenant's partition. */
async function grantState(
  tenantId: string,
  clientId: string,
): Promise<GrantState> {
  const store = createMongoOAuth(oauthDb, {
    partition: partitionOf(new ObjectId(tenantId)),
  });
  if (store.listClientGrants === undefined) {
    throw new Error("the OAuth store has no listClientGrants()");
  }
  let cursor: string | undefined;
  let state: GrantState = "none";
  do {
    const page = await store.listClientGrants(clientId, {
      cursor,
      limit: PAGE,
    });
    if (page.items.some((grant) => grant.revokedAt === null)) return "standing";
    if (page.items.length > 0) state = "revoked";
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return state;
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
        grantState,
        // The console's clients lock: serializes the check and the delete with console client writes
        // (consent approval does not take it, so a grant made in between is revoked with the agent).
        locked: (tenantId, work) =>
          exclusive(clientsKey({ _id: new ObjectId(tenantId) }), work),
        remove: async (tenantId, clientId) => {
          // The real tenant (its slug and status), as the console passes it.
          const tenant = await tenantsService.find(tenantId);
          if (tenant === undefined) return false;
          return (await clientsService.delete(tenant, clientId)).removed;
        },
        emit: (event) => adminEventRecorder.record(agentPruneEventInput(event)),
        log: warn,
      },
      now(),
    );
