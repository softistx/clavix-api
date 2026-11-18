import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { AgentClientsService } from "@/modules/agents/agent-clients.service";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";

/** The real agents store. The collection is tenant-owned: only this wiring and its module reach it. */
export const agentClientsService = new AgentClientsService(
  mongo.db.agentClients,
);

/** Whether janus stored this client of the tenant from a metadata document (the partition is the tenant's). */
export const isMetadataClient = async (
  tenant: ResolvedTenant,
  clientId: string,
): Promise<boolean> =>
  (
    await createMongoOAuth(oauthDb, { partition: tenant.partition }).findClient(
      clientId,
    )
  )?.source === "metadata";
