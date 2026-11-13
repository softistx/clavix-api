import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { getCollection, scopeToTenant } from "@softistx/mongo";
import { defineMigration } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { createClientIndex } from "@/modules/clients/client-index";
import { clientIndex } from "@/modules/clients/clients.model";
import { scopes } from "@/modules/resources/scopes.model";
import { partitionOf } from "@/modules/tenants/identity";
import { tenants } from "@/modules/tenants/tenants.model";

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

/**
 * The client id inside a key of the partitioned janus store
 * (`JSON.stringify([partition, id])`), or null when the key has another shape.
 */
function clientIdOf(key: unknown): string | null {
  try {
    const parts: unknown = JSON.parse(String(key));
    const id = Array.isArray(parts) ? parts[1] : undefined;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Lists the clients the janus store already holds in the console's
 * `clientIndex`. Idempotent. The store cannot list its clients yet, so this
 * reads its collection for the ids only (each record is then read through the
 * store): Temporary, until @softistx/janus-oauth#706 (`listClients`).
 */
export async function backfillClientIndex(db: Db): Promise<number> {
  const index = createClientIndex(getCollection(db, clientIndex));
  let indexed = 0;
  for (const tenant of await getCollection(db, tenants).findMany()) {
    const partition = partitionOf(tenant._id);
    const store = createMongoOAuth(db, { partition });
    const docs = await db
      .collection("oauthPartitionedClients")
      .find({ partition })
      .toArray();
    for (const doc of docs) {
      const clientId = clientIdOf(doc._id);
      if (clientId === null) continue;
      const record = await store.findClient(clientId);
      if (record === null || record.source !== "registered") continue;
      await index.upsert(tenant._id, {
        clientId: record.id,
        name: record.name,
        type: record.secretHash === undefined ? "public" : "confidential",
        redirectUris: record.redirectUris,
      });
      indexed += 1;
    }
  }
  return indexed;
}

// The console's scopes (ADR-0025) and client list. Needs `db:sync` (the
// `scopes` and `clientIndex` collections). Down puts the strings back on the
// resources and empties the list; the consent texts are lost.
export const scopesMigration = defineMigration({
  id,
  async up({ db }) {
    await moveScopesToDocuments(db);
    await backfillClientIndex(db);
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
    await db.collection("clientIndex").deleteMany({});
  },
});
