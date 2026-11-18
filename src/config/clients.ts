import { ClientsService } from "@/modules/clients/clients.service";
import { agentClientsService } from "./agent-clients";
import { clientPoliciesService } from "./client-policies";
import { oauthDb } from "./oauth-db";

/** A tenant's OAuth clients, for the console. */
export const clientsService = new ClientsService({
  db: oauthDb,
  policies: clientPoliciesService,
  agents: agentClientsService,
});
