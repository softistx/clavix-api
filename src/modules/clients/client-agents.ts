import type { CliTenant } from "@/cli/errors";
import type { AgentClientsService } from "@/modules/agents/agent-clients.service";
import { CatalogError } from "@/modules/resources/catalog.errors";
import type { AgentKinds, AgentKindsOf } from "./client-listing";

/** The part of the agents store the clients service reads. */
export type AgentsReader = Pick<AgentClientsService, "kinds" | "remove">;

/** Reads the tenant's agents among some client ids (bounded by them; none without the store). */
export const agentKindsOf =
  (agents: AgentsReader | undefined, tenant: CliTenant): AgentKindsOf =>
  async (clientIds): Promise<AgentKinds> =>
    (await agents?.kinds(tenant._id.toHexString(), clientIds)) ?? new Map();

/**
 * Refuses a write on an agent (dynamic or metadata): an agent is read-only in
 * the console, whatever its id looks like. It answers as an unknown client, and
 * runs before any validation that depends on the id.
 */
export async function refuseAgent(
  agents: AgentsReader | undefined,
  tenant: CliTenant,
  clientId: string,
): Promise<void> {
  if ((await agentKindsOf(agents, tenant)([clientId])).has(clientId)) {
    throw new CatalogError("NOT_FOUND", "No such client");
  }
}
