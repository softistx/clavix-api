/** A tenant's agents by client id, each with its registration time. */
export type AgentMarks = ReadonlyMap<string, Date>;

/**
 * Reads the agents of the tenant the request's host names, among the given
 * client ids only (none for an unknown host): a read bounded by the page's
 * clients, never the tenant's whole store.
 */
export type AgentsFor = (
  request: Request,
  clientIds: readonly string[],
) => Promise<AgentMarks>;

/** One read per request and client: the fields of a page share it. */
export function agentMarksReader() {
  const reads = new WeakMap<Request, Map<string, Promise<AgentMarks>>>();
  return (
    request: Request | undefined,
    agents: AgentsFor,
    clientId: string,
  ): Promise<AgentMarks> | undefined => {
    if (request === undefined) return undefined;
    let byClient = reads.get(request);
    if (byClient === undefined) {
      byClient = new Map();
      reads.set(request, byClient);
    }
    let marks = byClient.get(clientId);
    if (marks === undefined) {
      marks = agents(request, [clientId]);
      byClient.set(clientId, marks);
    }
    return marks;
  };
}

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
