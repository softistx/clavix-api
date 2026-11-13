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

/**
 * The purge job over the real stores, for a janus `PartitionPurger`. NOT
 * scheduled and without an implementation of the port: janus cannot purge a
 * partition yet (Temporary, until @softistx/janus-oauth-mongo#710), so the
 * trash is not emptied. The wiring is clavix-api#112.
 */
export const createTenantPurge = (partitions: PartitionPurger) => () =>
  purgeTenants({
    registry: tenantAdmin,
    // The custom domains are a platform collection (`domains`), emptied too.
    owned: [
      ...ownedPurgers(),
      { name: "domains", deleteOwnedBy: (id) => domainStore.deleteOwnedBy(id) },
    ],
    memberships: access,
    partitions,
  });
