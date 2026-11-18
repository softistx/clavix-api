/** A tenant's agents by client id, each with its registration time. */
export type AgentMarks = ReadonlyMap<string, Date>;

/** Reads the agents of the tenant the request's host names (none for an unknown host). */
export type AgentsFor = (request: Request) => Promise<AgentMarks>;

/** The `OAuthClient.agent` and `registeredAt` of a client, from the tenant's agents. */
export function markOf(
  marks: AgentMarks | undefined,
  clientId: string,
): { agent: boolean; registeredAt: string | null } {
  const at = marks?.get(clientId);
  return at === undefined
    ? { agent: false, registeredAt: null }
    : { agent: true, registeredAt: at.toISOString() };
}
