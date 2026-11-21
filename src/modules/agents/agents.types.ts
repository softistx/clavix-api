import type { AgentKind } from "./agents.model";

/** An agent to record: the client, how it came, and the digest of its registering address. */
export interface AgentRecordInput {
  clientId: string;
  kind: AgentKind;
  ipDigest?: string | null;
}

/** The part of the agents store the registration route needs. */
export interface AgentClientsPort {
  /** The tenant's agents now, of every kind or of one `kind` (the `agents` quota). */
  count(tenantId: string, kind?: AgentKind): Promise<number>;
  /** Records an agent; one already recorded is left as it is. */
  record(tenantId: string, agent: AgentRecordInput): Promise<void>;
  /** Forgets an agent (its client was deleted); one not recorded is a no-op. */
  remove(tenantId: string, clientId: string): Promise<void>;
  /** Whether the client is already a recorded agent of the tenant. */
  has(tenantId: string, clientId: string): Promise<boolean>;
}
