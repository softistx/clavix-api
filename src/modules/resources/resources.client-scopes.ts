import type { Collection, Db, ObjectId } from "mongodb";

// The part of a janus client record this port reads.
interface ClientScopes {
  _id: string;
  partition: string;
  allowedScopes?: string[];
  defaultScopes?: string[];
}

/**
 * The clients' scope lists, as the catalog needs them: which clients list a
 * scope name (a rename is refused while one does). The janus store partitions
 * its clients by the tenant's id, so a call sees one tenant's clients only.
 */
export interface ScopeClients {
  /** The ids of the tenant's clients that list `name` in `allowedScopes` or `defaultScopes`. */
  listing(tenantId: ObjectId, name: string): Promise<string[]>;
}

/** The real port, over the janus OAuth collections of `db` (`oauthDb`). */
export function mongoScopeClients(db: Db): ScopeClients {
  const clients: Collection<ClientScopes> = db.collection(
    "oauthPartitionedClients",
  );
  return {
    async listing(tenantId, name) {
      const found = await clients
        .find(
          {
            partition: tenantId.toHexString(),
            $or: [{ allowedScopes: name }, { defaultScopes: name }],
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      return found.map((client) => client._id);
    },
  };
}
