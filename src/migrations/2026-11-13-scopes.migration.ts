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
 *
 * A scope name is unique in a tenant now. Two resources of one tenant that
 * both list a name cannot both keep it: the migration stops before writing
 * anything and names them, so an operator renames one (`resources:create`
 * with the previous code) rather than a resource silently losing a scope.
 */
export async function moveScopesToDocuments(db: Db): Promise<number> {
  const resourceDocs = db.collection("resources");
  const scopeDocs = getCollection(db, scopes);
  const legacy = await resourceDocs
    .find({ scopes: { $exists: true } })
    .sort({ _id: 1 })
    .toArray();
  const namesOf = (resource: (typeof legacy)[number]) => [
    ...new Set(
      Array.isArray(resource["scopes"]) ? (resource["scopes"] as string[]) : [],
    ),
  ];

  // First pass, no write: who would own each name.
  const owners = new Map<string, string>();
  const clashes: string[] = [];
  for (const resource of legacy) {
    const owned = scopeToTenant(scopeDocs, resource["tenantId"]);
    for (const name of namesOf(resource)) {
      const key = `${String(resource["tenantId"])} ${name}`;
      const existing = await owned.findFirst({ name });
      const owner =
        owners.get(key) ??
        (existing === undefined
          ? undefined
          : (existing.resourceId?.toHexString() ?? "a standard scope"));
      if (owner !== undefined && owner !== String(resource._id)) {
        clashes.push(
          `scope "${name}" of resource ${resource["uri"]} (tenant ${String(resource["tenantId"])}) is already ${owner}'s`,
        );
      }
      owners.set(key, owner ?? String(resource._id));
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      `a scope name is unique in a tenant; rename before migrating: ${clashes.join("; ")}`,
    );
  }

  let created = 0;
  for (const resource of legacy) {
    const owned = scopeToTenant(scopeDocs, resource["tenantId"]);
    for (const name of namesOf(resource)) {
      if (await owned.exists({ name })) continue;
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
 * Lists the clients the janus store already holds in the console's
 * `clientIndex` (Temporary, until @softistx/janus-oauth#706). Idempotent.
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
      const record = await store.findClient(String(doc._id));
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
