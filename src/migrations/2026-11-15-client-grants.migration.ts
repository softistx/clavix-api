import { defineMigration } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";

export const id = "2026-11-15-client-grants";

const COLLECTIONS = ["oauthClients", "oauthPartitionedClients"] as const;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * janus-oauth 0.13 enforces a client's `grantTypes` and takes an explicit list
 * as written. Stored lists written before it migrate on both client
 * collections, in this order (janus-oauth's refresh guide):
 *
 * 1. a list with neither `authorization_code` nor the device grant (`[]`,
 *    `['refresh_token']`) can use no grant: it gets both default grants;
 * 2. an explicit list that lacks `refresh_token` gets it (a client that
 *    refreshed before keeps refreshing).
 *
 * A client with no list is untouched (the default is both grants). Idempotent:
 * a second run matches nothing. Returns how many documents each step changed.
 */
export async function migrateClientGrants(
  db: Db,
): Promise<{ unusable: number; withoutRefresh: number }> {
  let unusable = 0;
  let withoutRefresh = 0;
  for (const name of COLLECTIONS) {
    unusable += (
      await db.collection(name).updateMany(
        {
          grantTypes: {
            $exists: true,
            $nin: ["authorization_code", DEVICE_GRANT],
          },
        },
        {
          $addToSet: {
            grantTypes: { $each: ["authorization_code", "refresh_token"] },
          },
        },
      )
    ).modifiedCount;
  }
  for (const name of COLLECTIONS) {
    withoutRefresh += (
      await db
        .collection(name)
        .updateMany(
          { grantTypes: { $exists: true, $ne: [], $nin: ["refresh_token"] } },
          { $addToSet: { grantTypes: "refresh_token" } },
        )
    ).modifiedCount;
  }
  return { unusable, withoutRefresh };
}

// Needs `db:sync` (the OAuth collections). Down changes nothing: the lists it
// repaired cannot be told from the ones written with the grants.
export const clientGrantsMigration = defineMigration({
  id,
  async up({ db }) {
    await migrateClientGrants(db);
  },
  async down() {},
});
