import type { Collection, Db, ObjectId } from "mongodb";

// The part of a janus client record this port reads and writes.
interface ClientLists {
  partition: string;
  authorizationDetailsTypes?: string[];
}

/**
 * The clients' `authorizationDetailsTypes` lists, as the catalog needs them:
 * which clients list a type (D6: a listed type cannot be deleted) and the
 * removal of types from every list (a deleted resource's types). The janus
 * store partitions its clients by the tenant's id, so a call sees one tenant's
 * clients only.
 */
export interface DetailTypeClients {
  /** The ids of the tenant's clients that list at least one of `types`. */
  using(tenantId: ObjectId, types: readonly string[]): Promise<string[]>;
  /** Removes `types` from the tenant's clients' lists; how many clients changed. */
  drop(tenantId: ObjectId, types: readonly string[]): Promise<number>;
}

/** The real port, over the janus OAuth collections of `db` (`oauthDb`). */
export function mongoDetailTypeClients(db: Db): DetailTypeClients {
  const clients: Collection<ClientLists> = db.collection(
    "oauthPartitionedClients",
  );
  return {
    async using(tenantId, types) {
      if (types.length === 0) return [];
      const found = await clients
        .find(
          {
            partition: tenantId.toHexString(),
            authorizationDetailsTypes: { $in: [...types] },
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      return found.map((client) =>
        String((client as unknown as { _id: string })._id),
      );
    },
    async drop(tenantId, types) {
      if (types.length === 0) return 0;
      const done = await clients.updateMany(
        {
          partition: tenantId.toHexString(),
          authorizationDetailsTypes: { $in: [...types] },
        },
        { $pull: { authorizationDetailsTypes: { $in: [...types] } } },
      );
      return done.modifiedCount;
    },
  };
}
