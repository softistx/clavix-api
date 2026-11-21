import { ClientsService } from "@/modules/clients/clients.service";
import { agentClientsService } from "./agent-clients";
import { clientPoliciesService } from "./client-policies";
import { oauthDb } from "./oauth-db";
import { clientDetailTypes } from "./resources";
import { clock } from "./runtime";

/** A tenant's OAuth clients, for the console. */
export const clientsService = new ClientsService({
  db: oauthDb,
  policies: clientPoliciesService,
  agents: agentClientsService,
  detailTypes: clientDetailTypes,
  now: clock,
});
