import { defineMigration } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";

export const id = "2026-11-16-oauth-policy";

/**
 * M3 adds the tenant's OAuth policy. A tenant stored before it reads every
 * requirement off through the schema's defaults; this writes the `false`
 * explicitly, so a later change of the default cannot switch a tenant on. Only
 * a missing field is written (a policy an admin set is never touched), and the
 * write moves neither `version` nor `updatedAt`. Idempotent: a second run
 * matches nothing. Returns how many tenants it changed.
 */
export async function migrateOAuthPolicy(db: Db): Promise<number> {
  const { modifiedCount } = await db
    .collection("tenants")
    .updateMany({ oauth: { $exists: false } }, [
      {
        $set: {
          oauth: {
            par: { required: false },
            dpop: { required: false },
            agents: {
              dynamic: "off",
              redirectUris: [],
              metadataDocuments: false,
              allowHosts: [],
            },
          },
        },
      },
    ]);
  return modifiedCount;
}

// Needs `db:sync` first (the tenants validator). Down changes nothing: a tenant
// that kept `false` reads the same without the field.
export const oauthPolicyMigration = defineMigration({
  id,
  async up({ db }) {
    await migrateOAuthPolicy(db);
  },
  async down() {},
});
