import {
  ConflictError,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { AgentKind, agentClients } from "./agents.model";
import type { AgentClientsPort, AgentRecordInput } from "./agents.types";

/**
 * A tenant's agents. Every method takes the tenant's id and reads or writes
 * through that tenant's scope, so an agent of A is unknown to B.
 */
export class AgentsService implements AgentClientsPort {
  constructor(
    private readonly collection: TypedCollection<typeof agentClients>,
  ) {}

  private scoped(tenantId: string) {
    return scopeToTenant(this.collection, new ObjectId(tenantId));
  }

  async count(tenantId: string, kind?: AgentKind): Promise<number> {
    return this.scoped(tenantId).count(kind === undefined ? {} : { kind });
  }

  async has(tenantId: string, clientId: string): Promise<boolean> {
    return (await this.scoped(tenantId).findFirst({ clientId })) !== undefined;
  }

  /**
   * The kind of each recorded agent of the tenant, by client id: all of them,
   * or only the `clientIds` given. A client that is no agent is absent.
   */
  async kinds(
    tenantId: string,
    clientIds?: readonly string[],
  ): Promise<Map<string, AgentKind>> {
    if (clientIds?.length === 0) return new Map();
    const found = await this.scoped(tenantId).findMany(
      clientIds === undefined
        ? {}
        : { filter: { clientId: { $in: [...clientIds] } } },
    );
    return new Map(found.map((agent) => [agent.clientId, agent.kind]));
  }

  /**
   * The registration time of each recorded agent among the `clientIds`, by
   * client id: a read bounded by the ids, never the tenant's whole store.
   */
  async registeredAt(
    tenantId: string,
    clientIds: readonly string[],
  ): Promise<Map<string, Date>> {
    if (clientIds.length === 0) return new Map();
    const found = await this.scoped(tenantId).findMany({
      filter: { clientId: { $in: [...clientIds] } },
    });
    return new Map(found.map((agent) => [agent.clientId, agent.createdAt]));
  }

  /** The ids of the tenant's agents, of every kind, recorded before `before` (the clean-up job). */
  async registeredBefore(tenantId: string, before: Date): Promise<string[]> {
    const found = await this.scoped(tenantId).findMany({
      filter: { createdAt: { $lt: before } },
      sort: { createdAt: 1 },
    });
    return found.map((agent) => agent.clientId);
  }

  async remove(tenantId: string, clientId: string): Promise<void> {
    const found = await this.scoped(tenantId).findFirst({ clientId });
    if (found !== undefined) await this.scoped(tenantId).delete(found._id);
  }

  async record(tenantId: string, agent: AgentRecordInput): Promise<void> {
    try {
      await this.scoped(tenantId).create({
        clientId: agent.clientId,
        kind: agent.kind,
        ipDigest: agent.ipDigest ?? null,
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
}
