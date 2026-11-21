import type { Collection, ObjectId } from "mongodb";
import * as appCollections from "@/modules/collections";
import type { OwnedCollectionPurger, PartitionPurger } from "@/modules/tenants";
import { isOwned } from "@/tenancy/owned";
import { access } from "./access";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";
import { createPartitionPurger } from "./partition-purger";
import { warn } from "./runtime";
import { domainsService, tenantsService } from "./tenancy";

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
  (
    now: () => Date,
    partitions: PartitionPurger = createPartitionPurger(oauthDb),
  ) =>
  () =>
    tenantsService.purge(
      {
        // The custom domains are a platform collection (`domains`), emptied too.
        owned: [
          ...ownedPurgers(),
          {
            name: "domains",
            deleteOwnedBy: (id) => domainsService.deleteOwnedBy(id),
          },
        ],
        memberships: access,
        partitions,
        log: warn,
      },
      now(),
    );
