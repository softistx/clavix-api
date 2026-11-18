/** What the daily clean-up did: an agent of the tenant was deleted. */
export interface AgentPruneEvent {
  /** The tenant's hex id. */
  tenantId: string;
  /** The deleted client's id. */
  clientId: string;
}

// Like `system:domains:recheck`: a system actor is `system:<module>:<job>`,
// not the id of a user.
export const PRUNE_ACTOR = "system:agents:prune";

/** The admin event, shaped like the console's `AdminEventInput`: identifiers only, a request id of its own. */
export const agentPruneEventInput = (event: AgentPruneEvent) => ({
  actor: PRUNE_ACTOR,
  action: "agent.prune" as const,
  tenantId: event.tenantId,
  target: { type: "client", id: event.clientId.slice(0, 200) },
  requestId: crypto.randomUUID(),
});
