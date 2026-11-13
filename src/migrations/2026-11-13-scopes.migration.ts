import { getCollection, scopeToTenant } from "@softistx/mongo";
import { defineMigration } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { scopes } from "@/modules/resources/scopes.model";

export const id = "2026-11-13-scopes";

/**
 * Moves each resource's `scopes` strings to `Scope` documents (empty consent
 * texts, the resource as owner; one the resource has already is left alone),
 * then removes the strings. Returns how many scopes it created.
 */
export async function moveScopesToDocuments(db: Db): Promise<number> {
  const resourceDocs = db.collection("resources");
  const scopeDocs = getCollection(db, scopes);
  let created = 0;
  for (const resource of await resourceDocs
    .find({ scopes: { $exists: true } })
    .toArray()) {
    const names = Array.isArray(resource["scopes"])
      ? (resource["scopes"] as string[])
      : [];
    const owned = scopeToTenant(scopeDocs, resource["tenantId"]);
    for (const name of new Set(names)) {
      if (await owned.exists({ name, resourceId: resource._id })) continue;
      await owned.create({
        name,
        description: { fr: "", en: "" },
        resourceId: resource._id,
        claims: [],
      });
      created += 1;
    }
    await resourceDocs.updateOne(
      { _id: resource._id },
      { $unset: { scopes: "" } },
    );
  }
  return created;
}

// The console's scopes (ADR-0025). Needs `db:sync` (the `scopes` collection).
// Down puts the strings back on the resources; the consent texts are lost.
export const scopesMigration = defineMigration({
  id,
  async up({ db }) {
    await moveScopesToDocuments(db);
  },
  async down({ db }) {
    const scopeDocs = db.collection("scopes");
    for (const resource of await db.collection("resources").find().toArray()) {
      const names = (
        await scopeDocs
          .find({ tenantId: resource["tenantId"], resourceId: resource._id })
          .toArray()
      ).map((scope) => scope["name"] as string);
      await db
        .collection("resources")
        .updateOne({ _id: resource._id }, { $set: { scopes: names } });
    }
    await scopeDocs.deleteMany({});
  },
});
