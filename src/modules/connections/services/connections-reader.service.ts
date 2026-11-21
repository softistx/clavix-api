import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { ConnectionError } from "../connections.errors";
import type { ConnectionDoc, connections } from "../connections.model";

/** Reads a tenant's connections through its scope: a connection of A is unknown to B. */
export class ConnectionsReader {
  constructor(
    private readonly collection: TypedCollection<typeof connections>,
  ) {}

  scoped(tenantId: string) {
    return scopeToTenant(this.collection, new ObjectId(tenantId));
  }

  count(tenantId: string): Promise<number> {
    return this.scoped(tenantId).count();
  }

  list(tenantId: string): Promise<ConnectionDoc[]> {
    return this.scoped(tenantId).findMany({ sort: { createdAt: 1 } });
  }

  async find(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionDoc | undefined> {
    const [found] = await this.scoped(tenantId).findMany({
      filter: { connectionId },
      limit: 1,
    });
    return found;
  }

  async get(tenantId: string, connectionId: string): Promise<ConnectionDoc> {
    const found = await this.find(tenantId, connectionId);
    if (found === undefined) {
      throw new ConnectionError("NOT_FOUND", "No such connection");
    }
    return found;
  }

  /** A domain of `domains` that another enabled connection of the tenant already holds. */
  async assertDomainsFree(
    tenantId: string,
    except: ConnectionDoc,
    domains: readonly string[],
  ): Promise<void> {
    if (domains.length === 0) return;
    const others = await this.scoped(tenantId).findMany({
      filter: { enabled: true, "domains.domain": { $in: [...domains] } },
    });
    if (others.some((other) => !other._id.equals(except._id))) {
      throw new ConnectionError(
        "DOMAIN_TAKEN",
        "A domain of this connection is already held by another enabled connection",
        "domains",
      );
    }
  }
}
