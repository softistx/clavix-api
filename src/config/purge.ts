import type { Collection, ObjectId } from "mongodb";
import * as appCollections from "@/modules/collections";
import {
  type OwnedCollectionPurger,
  type PartitionPurger,
  purgeTenants,
} from "@/modules/tenants/purge";
import { isOwned } from "@/tenancy/owned";
import { access } from "./access";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";
import { createPartitionPurger } from "./partition-purger";
import { domainStore, tenantAdmin } from "./tenancy";

/**
 * The tenant-owned collections of the app (`isOwned`: `adminEvents`, the
 * platform's record, is not one), each emptied of one tenant's documents.
 */
export const ownedPurgers = (): OwnedCollectionPurger[] =>
  Object.entries(appCollections)
    .filter(([, definition]) => isOwned(definition))
    .map(([key, definition]) => ({
      name: definition.name,
      deleteOwnedBy: async (tenantId: ObjectId) => {
        const { raw } = (
          mongo.db as unknown as Record<string, { raw: Collection }>
        )[key] as { raw: Collection };
        return (await raw.deleteMany({ tenantId })).deletedCount;
      },
    }));

/** The purge job over the real stores: the janus partition purges, the owned collections, the roles. */
export const createTenantPurge =
  (partitions: PartitionPurger = createPartitionPurger(oauthDb)) =>
  () =>
    purgeTenants({
      registry: tenantAdmin,
      // The custom domains are a platform collection (`domains`), emptied too.
      owned: [
        ...ownedPurgers(),
        {
          name: "domains",
          deleteOwnedBy: (id) => domainStore.deleteOwnedBy(id),
        },
      ],
      memberships: access,
      partitions,
    });
