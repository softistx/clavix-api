import {
  purgeMongoInvitationsPartition,
  purgeMongoStoresPartition,
} from "@softistx/janus-mongo";
import { purgeMongoOAuthPartition } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import type { PartitionPurger } from "@/modules/tenants";

/**
 * The janus partition purges (OAuth, stores, invitations) over the database
 * the tenants' janus instances share. A tenant's partition is its hex id,
 * never `default`: that name is refused, so `signingKeys` is never passed to
 * dodge janus's own guard on the unpartitioned layout.
 */
export const createPartitionPurger = (db: Db): PartitionPurger => ({
  async purgePartition(partition) {
    if (partition === "" || partition === "default")
      throw new TypeError(
        `purge: ${JSON.stringify(partition)} is not a tenant partition`,
      );
    const oauth = await purgeMongoOAuthPartition(db, { partition });
    const stores = await purgeMongoStoresPartition(db, { partition });
    const invitations = await purgeMongoInvitationsPartition(db, { partition });
    return { ...oauth, ...stores, ...invitations };
  },
});
