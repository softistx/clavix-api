import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { AgentsService } from "@/modules/agents";
import type { AgentsFor } from "@/modules/consent";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";
import { tenantResolver } from "./tenancy";

/** The real agents store. The collection is tenant-owned: only this wiring and its module reach it. */
export const agentClientsService = new AgentsService(mongo.db.agentClients);

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

/** The agents of the tenant the request's host names, for the hosted pages' `OAuthClient.agent`. */
export const agentsFor: AgentsFor = async (request, clientIds) => {
  const tenant = await tenantResolver.resolveRequest(request);
  return tenant === null
    ? new Map()
    : agentClientsService.registeredAt(tenant.tenantId, clientIds);
};
