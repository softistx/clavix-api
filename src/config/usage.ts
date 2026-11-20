import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { ObjectId } from "mongodb";
import { partitionOf } from "@/modules/tenants/identity";
import { UsageService } from "@/modules/usage/usage.service";
import { agentClientsService } from "./agent-clients";
import { connectionsService } from "./connections";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";
import { redis } from "./redis";
import { domainStore } from "./tenancy";
import { webhookEndpoints } from "./webhook-endpoints";

// The tenant's partition of the janus store counts its own registered clients
// (`countClients({ source })`, on the `source` index `db:sync` creates).
const countRegisteredClients = async (tenantId: string): Promise<number> => {
  const store = createMongoOAuth(oauthDb, {
    partition: partitionOf(new ObjectId(tenantId)),
  });
  if (store.countClients === undefined) {
    throw new Error("the janus OAuth store has no countClients");
  }
  return store.countClients({ source: "registered" });
};

// Agents that registered themselves are `source: "registered"` clients of the
// janus store too (J4), but they do not count against the hard `clients` quota
// (D9): the agents are subtracted.
/**
 * The real usage meters. The `usageCounters` collection is tenant-owned: only
 * this wiring and its module reach it. Clients are counted in the tenant's
 * partition of the janus OAuth collections; custom domains are the tenant's
 * claims in the domain store, pending ones included (a hard quota).
 */
export const usageService = new UsageService(
  mongo.db.usageCounters,
  {
    clients: async (tenantId) => {
      const [registered, agents] = await Promise.all([
        countRegisteredClients(tenantId),
        agentClientsService.count(tenantId, "dynamic"),
      ]);
      return Math.max(0, registered - agents);
    },
    agents: (tenantId) => agentClientsService.count(tenantId),
    webhooks: (tenantId) => webhookEndpoints.count(tenantId),
    connections: (tenantId) => connectionsService.count(tenantId),
    domains: (tenantId) => domainStore.count(new ObjectId(tenantId)),
  },
  redis?.mau,
);
